import "dotenv/config";
import express from "express";
import cors from "cors";
import { WebSocketServer } from "ws";
import http from "http";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import path from "path";
import fs from "fs";
import multer from "multer";
import db from "./db.js";
import { moderateText, isRealImage } from "./moderation.js";

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 4000;

// JWT-секрет: обязательно задавай через переменные окружения в проде.
// Если не задан — генерируем случайный на время работы процесса (все токены
// "слетят" при перезапуске), чтобы не хардкодить секрет в коде.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.JWT_SECRET) {
  console.warn("⚠️  JWT_SECRET не задан в переменных окружения — используется случайный ключ на время работы процесса. Задай JWT_SECRET в .env (локально) и в настройках Render (в проде), иначе все выданные токены станут недействительными при каждом перезапуске сервера.");
}
const JWT_EXPIRES_IN = "7d";

// ===== Хеширование паролей =====
// Встроенный crypto.scrypt — без новой npm-зависимости (bcrypt/argon2 — это
// нативные модули, а на этой машине уже был случай, когда нативный модуль
// (better-sqlite3) не собрался без Visual Studio Build Tools; scrypt того же
// уровня стойкости, входит в Node "из коробки").
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${salt}:${hash}`;
}

const PASSWORD_HASH_RE = /^[0-9a-f]{32}:[0-9a-f]{128}$/i;

function verifyPassword(password, stored) {
  if (typeof stored !== "string" || !PASSWORD_HASH_RE.test(stored)) return false;
  const [salt, hash] = stored.split(":");
  const hashBuffer = Buffer.from(hash, "hex");
  const testHash = crypto.scryptSync(password, salt, 64);
  return hashBuffer.length === testHash.length && crypto.timingSafeEqual(hashBuffer, testHash);
}

const ID_LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// ID пользователя — 6 цифр + 2 заглавные буквы (например "482913XQ"),
// вместо UUID, чтобы было короче и легче продиктовать/ввести вручную.
function generateUserId() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const digits = crypto.randomInt(0, 1_000_000).toString().padStart(6, "0");
    const letters =
      ID_LETTERS[crypto.randomInt(0, ID_LETTERS.length)] +
      ID_LETTERS[crypto.randomInt(0, ID_LETTERS.length)];
    const id = digits + letters;
    if (!stmts.findUserById.get(id)) return id;
  }
  throw new Error("Не удалось сгенерировать уникальный ID пользователя");
}

app.use(cors());
app.use(express.json());

// Загруженные файлы — СВОЙ маршрут, зарегистрированный РАНЬШЕ корневой
// статики ниже. Порядок критичен: каталог uploads/ физически лежит внутри
// корня проекта, и если сперва зарегистрировать общий express.static(корень),
// он сам находит и отдаёт файлы из uploads/ в обход этого блока — заголовки
// безопасности ниже просто никогда бы не применялись.
// Отдаём только картинки "инлайн" (можно вставить как <img>). Всё остальное —
// с Content-Disposition: attachment, чтобы браузер скачивал файл, а не
// пытался исполнить его (иначе кто-нибудь пришлёт .html/.svg со скриптом,
// и он выполнится в контексте нашего же origin — с доступом к localStorage).
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(process.cwd(), "uploads");
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
const INLINE_EXT = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
app.use("/uploads", express.static(UPLOADS_DIR, {
  setHeaders: (res, filePath) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    if (!INLINE_EXT.has(path.extname(filePath).toLowerCase())) {
      res.setHeader("Content-Disposition", "attachment");
    }
  }
}));

// Отдаём статику фронтенда (для локальной разработки — в проде фронтенд
// может быть захостен отдельно, этот роут просто не будет использоваться).
// Явный список файлов — чтобы express.static не начал раздавать server.js,
// db.js, .env или сам файл базы data/lomo.db всем желающим.
const PUBLIC_FILES = new Set([
  "index.html", "auth.html", "chats.html", "users.html", "admin.html",
  "groups.html", "music.html", "video.html", "books.html",
  "profile.html", "friends.html", "group.html", "photos.html", "account.html",
  "styles.css", "app.js", "components.js", "Gingle.WAV",
  "manifest.json", "sw.js", "icon-192.png", "icon-512.png"
]);
app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.path.startsWith("/uploads/")) return next();
  const name = decodeURIComponent(req.path.replace(/^\//, ""));
  if (name === "" || PUBLIC_FILES.has(name)) return next();
  res.status(404).end();
});
app.use(express.static(path.resolve(process.cwd())));

const uploadStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});

// Строго для фотоальбомов — только изображения.
const upload = multer({
  storage: uploadStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("image/"))
});

// Общая загрузка (фото в посте, файл в чате) — любой файл, кроме опасных
// исполняемых/скриптовых расширений (доп. защита поверх Content-Disposition
// выше — так спуфинг через двойное расширение тоже ничего не даст).
const DANGEROUS_EXT = new Set([
  ".html", ".htm", ".svg", ".js", ".mjs", ".php", ".exe", ".com",
  ".bat", ".cmd", ".sh", ".jar", ".msi", ".apk", ".dll"
]);
const uploadAny = multer({
  storage: uploadStorage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, !DANGEROUS_EXT.has(path.extname(file.originalname).toLowerCase()))
});

// busboy (которым пользуется multer) по умолчанию декодирует имя файла из
// multipart-заголовка как latin1, а не utf8 — с русскими/любыми не-ASCII
// именами это даёт кракозябры ("Ð¡ÐºÑÐ¸Ð½..."). Перекодируем обратно.
function fixFilenameEncoding(name) {
  return Buffer.from(name, "latin1").toString("utf8");
}

// Файл уже физически лежит на диске (diskStorage) к моменту, когда роут
// получает управление — читаем первые байты и проверяем сигнатуру формата
// (см. moderation.js). Ловит случай, когда клиент подделал mimetype/
// расширение, а на самом деле прислал не картинку. При провале удаляет
// уже записанный файл с диска, чтобы не плодить мусор в uploads/.
function rejectIfFakeImage(file) {
  if (!file || !file.mimetype.startsWith("image/")) return null;
  let buf;
  try {
    const fd = fs.openSync(file.path, "r");
    buf = Buffer.alloc(16);
    fs.readSync(fd, buf, 0, 16, 0);
    fs.closeSync(fd);
  } catch (e) {
    return "Не удалось прочитать файл";
  }
  if (!isRealImage(buf)) {
    try { fs.unlinkSync(file.path); } catch (e) {}
    return "Файл повреждён или на самом деле не является картинкой";
  }
  return null;
}

// Подготовленные запросы к SQLite
const stmts = {
  findUserByLogin: db.prepare("SELECT * FROM users WHERE login = ?"),
  findUserById: db.prepare("SELECT * FROM users WHERE id = ?"),
  insertUser: db.prepare("INSERT INTO users (id, login, password, avatarUrl, isAdmin, createdAt) VALUES (?, ?, ?, ?, 0, ?)"),
  updatePassword: db.prepare("UPDATE users SET password = ? WHERE id = ?"),
  updateUserProfile: db.prepare("UPDATE users SET avatarUrl = ?, about = ?, displayName = ? WHERE id = ?"),

  // ===== Админка =====
  countUsers: db.prepare("SELECT COUNT(*) AS c FROM users"),
  countAdmins: db.prepare("SELECT COUNT(*) AS c FROM users WHERE isAdmin = 1"),
  countBanned: db.prepare("SELECT COUNT(*) AS c FROM users WHERE isBanned = 1"),
  countAllPosts: db.prepare("SELECT COUNT(*) AS c FROM posts"),
  countAllComments: db.prepare("SELECT COUNT(*) AS c FROM comments"),
  countAllMessages: db.prepare("SELECT COUNT(*) AS c FROM messages"),
  countAllGroups: db.prepare("SELECT COUNT(*) AS c FROM groups"),
  countAllPhotos: db.prepare("SELECT COUNT(*) AS c FROM photos"),
  countAllStories: db.prepare("SELECT COUNT(*) AS c FROM stories"),
  listAllUsers: db.prepare("SELECT * FROM users WHERE login LIKE ? ORDER BY (createdAt IS NULL), createdAt DESC"),
  setUserAdmin: db.prepare("UPDATE users SET isAdmin = ? WHERE id = ?"),
  setUserBanned: db.prepare("UPDATE users SET isBanned = ? WHERE id = ?"),
  deleteUser: db.prepare("DELETE FROM users WHERE id = ?"),
  deletePostsByAuthor: db.prepare("DELETE FROM posts WHERE authorId = ?"),
  deleteCommentsByAuthor: db.prepare("DELETE FROM comments WHERE authorId = ?"),
  deleteLikesByUser: db.prepare("DELETE FROM likes WHERE userId = ?"),
  deleteFriendshipsByUser: db.prepare("DELETE FROM friendships WHERE userA = ? OR userB = ?"),
  deleteGroupMembershipsByUser: db.prepare("DELETE FROM group_members WHERE userId = ?"),
  findAlbumIdsByOwner: db.prepare("SELECT id FROM albums WHERE ownerId = ?"),
  findPhotosByOwner: db.prepare("SELECT id, filename FROM photos WHERE ownerId = ?"),
  deleteAlbumRow: db.prepare("DELETE FROM albums WHERE id = ?"),
  deletePhotoRow: db.prepare("DELETE FROM photos WHERE id = ?"),
  deleteStoriesByOwner: db.prepare("DELETE FROM stories WHERE ownerId = ?"),
  listRecentPosts: db.prepare(`
    SELECT p.* FROM posts p
    WHERE p.text LIKE ?
    ORDER BY p.createdAt DESC
    LIMIT 60
  `),
  listAllGroupsAdmin: db.prepare("SELECT * FROM groups ORDER BY createdAt DESC"),
  findCommentById: db.prepare("SELECT * FROM comments WHERE id = ?"),
  deleteCommentRow: db.prepare("DELETE FROM comments WHERE id = ?"),
  findPostIdsByAuthor: db.prepare("SELECT id FROM posts WHERE authorId = ?"),
  findGroupIdsByOwner: db.prepare("SELECT id FROM groups WHERE ownerId = ?"),
  insertMessage: db.prepare("INSERT INTO messages (id, room, fromLogin, text, avatar, ts, fileUrl, fileName, fromDisplayName) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  lastMessages: db.prepare("SELECT * FROM messages WHERE room = ? ORDER BY ts DESC LIMIT 50"),
  findMessageById: db.prepare("SELECT * FROM messages WHERE id = ?"),
  updateMessagePoll: db.prepare("UPDATE messages SET pollData = ? WHERE id = ?"),
  updateMessageChecklist: db.prepare("UPDATE messages SET checklistData = ? WHERE id = ?"),

  insertChatRoom: db.prepare("INSERT INTO chat_rooms (id, name, avatarUrl, ownerId, createdAt) VALUES (?, ?, ?, ?, ?)"),
  findChatRoom: db.prepare("SELECT * FROM chat_rooms WHERE id = ?"),
  updateChatRoom: db.prepare("UPDATE chat_rooms SET name = ?, avatarUrl = ? WHERE id = ?"),

  insertChatReport: db.prepare("INSERT INTO chat_reports (id, room, reporterId, note, createdAt) VALUES (?, ?, ?, ?, ?)"),
  listChatReports: db.prepare("SELECT * FROM chat_reports ORDER BY createdAt DESC"),
  deleteChatReport: db.prepare("DELETE FROM chat_reports WHERE id = ?"),

  // Поиск людей: подстрока логина ИЛИ точное совпадение ID — одна строка поиска.
  searchUsers: db.prepare("SELECT * FROM users WHERE (login LIKE ? OR id = ?) AND id <> ? ORDER BY login LIMIT 20"),

  insertPost: db.prepare("INSERT INTO posts (id, ownerType, ownerId, authorId, text, photoUrl, createdAt, moderationStatus, moderationReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
  findPostById: db.prepare("SELECT * FROM posts WHERE id = ?"),
  listPosts: db.prepare("SELECT * FROM posts WHERE ownerType = ? AND ownerId = ? ORDER BY createdAt DESC"),
  deletePost: db.prepare("DELETE FROM posts WHERE id = ?"),
  approvePost: db.prepare("UPDATE posts SET moderationStatus = 'clean', moderationReason = NULL WHERE id = ?"),
  listFlaggedPosts: db.prepare("SELECT * FROM posts WHERE moderationStatus = 'flagged' ORDER BY createdAt DESC"),

  likePost: db.prepare("INSERT OR IGNORE INTO likes (postId, userId, createdAt) VALUES (?, ?, ?)"),
  unlikePost: db.prepare("DELETE FROM likes WHERE postId = ? AND userId = ?"),
  findLike: db.prepare("SELECT 1 FROM likes WHERE postId = ? AND userId = ?"),
  countLikes: db.prepare("SELECT COUNT(*) AS c FROM likes WHERE postId = ?"),
  deleteLikesForPost: db.prepare("DELETE FROM likes WHERE postId = ?"),

  insertComment: db.prepare("INSERT INTO comments (id, postId, authorId, text, photoUrl, createdAt, moderationStatus, moderationReason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  listComments: db.prepare("SELECT * FROM comments WHERE postId = ? ORDER BY createdAt ASC"),
  countComments: db.prepare("SELECT COUNT(*) AS c FROM comments WHERE postId = ? AND moderationStatus <> 'flagged'"),
  deleteCommentsForPost: db.prepare("DELETE FROM comments WHERE postId = ?"),
  approveComment: db.prepare("UPDATE comments SET moderationStatus = 'clean', moderationReason = NULL WHERE id = ?"),
  listFlaggedComments: db.prepare("SELECT * FROM comments WHERE moderationStatus = 'flagged' ORDER BY createdAt DESC"),

  findFriendship: db.prepare("SELECT * FROM friendships WHERE userA = ? AND userB = ?"),
  insertFriendship: db.prepare("INSERT INTO friendships (id, userA, userB, status, requestedBy, createdAt) VALUES (?, ?, ?, ?, ?, ?)"),
  acceptFriendship: db.prepare("UPDATE friendships SET status = 'accepted' WHERE userA = ? AND userB = ?"),
  deleteFriendship: db.prepare("DELETE FROM friendships WHERE userA = ? AND userB = ?"),
  listFriends: db.prepare(`
    SELECT u.* FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.userA = ? THEN f.userB ELSE f.userA END)
    WHERE (f.userA = ? OR f.userB = ?) AND f.status = 'accepted'
    ORDER BY u.login
  `),
  listIncomingRequests: db.prepare(`
    SELECT u.* FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.userA = ? THEN f.userB ELSE f.userA END)
    WHERE (f.userA = ? OR f.userB = ?) AND f.status = 'pending' AND f.requestedBy <> ?
    ORDER BY f.createdAt DESC
  `),
  // Подписки — заявки, отправленные МНОЙ и ещё не принятые. Стены и так
  // публичны для любого залогиненного (см. CLAUDE.md), поэтому это не
  // отдельный уровень доступа, а просто список "кого я хочу видеть в
  // друзьях, но пока в одну сторону" — та же семантика, что в ВК 2010.
  listOutgoingRequests: db.prepare(`
    SELECT u.* FROM friendships f
    JOIN users u ON u.id = (CASE WHEN f.userA = ? THEN f.userB ELSE f.userA END)
    WHERE (f.userA = ? OR f.userB = ?) AND f.status = 'pending' AND f.requestedBy = ?
    ORDER BY f.createdAt DESC
  `),

  insertGroup: db.prepare("INSERT INTO groups (id, name, description, avatarUrl, ownerId, createdAt) VALUES (?, ?, ?, ?, ?, ?)"),
  findGroupById: db.prepare("SELECT * FROM groups WHERE id = ?"),
  listGroups: db.prepare("SELECT * FROM groups ORDER BY createdAt DESC"),
  deleteGroup: db.prepare("DELETE FROM groups WHERE id = ?"),
  deletePostsForOwner: db.prepare("DELETE FROM posts WHERE ownerType = ? AND ownerId = ?"),

  insertMember: db.prepare("INSERT OR IGNORE INTO group_members (groupId, userId, role, joinedAt) VALUES (?, ?, ?, ?)"),
  findMember: db.prepare("SELECT * FROM group_members WHERE groupId = ? AND userId = ?"),
  deleteMember: db.prepare("DELETE FROM group_members WHERE groupId = ? AND userId = ?"),
  countMembers: db.prepare("SELECT COUNT(*) AS c FROM group_members WHERE groupId = ?"),
  deleteMembersForGroup: db.prepare("DELETE FROM group_members WHERE groupId = ?"),

  insertAlbum: db.prepare("INSERT INTO albums (id, ownerId, title, createdAt) VALUES (?, ?, ?, ?)"),
  findAlbumById: db.prepare("SELECT * FROM albums WHERE id = ?"),
  listAlbumsByOwner: db.prepare("SELECT * FROM albums WHERE ownerId = ? ORDER BY createdAt DESC"),
  insertPhoto: db.prepare("INSERT INTO photos (id, albumId, ownerId, filename, originalName, createdAt) VALUES (?, ?, ?, ?, ?, ?)"),
  listPhotosByAlbum: db.prepare("SELECT * FROM photos WHERE albumId = ? ORDER BY createdAt DESC"),
  findPhotoById: db.prepare("SELECT * FROM photos WHERE id = ?"),
  deletePhoto: db.prepare("DELETE FROM photos WHERE id = ?"),

  insertStory: db.prepare("INSERT INTO stories (id, ownerId, photoUrl, createdAt) VALUES (?, ?, ?, ?)"),
  findStoryById: db.prepare("SELECT * FROM stories WHERE id = ?"),
  deleteStory: db.prepare("DELETE FROM stories WHERE id = ?"),
  deleteExpiredStories: db.prepare("DELETE FROM stories WHERE createdAt <= ?"),
  listActiveStories: db.prepare(`
    SELECT s.*, u.login AS ownerLogin, u.avatarUrl AS ownerAvatar
    FROM stories s JOIN users u ON u.id = s.ownerId
    WHERE s.createdAt > ?
    ORDER BY s.createdAt DESC
  `),

  // Лента: свои посты + посты друзей + посты групп, в которых состоишь.
  feedPosts: db.prepare(`
    SELECT p.* FROM posts p
    WHERE
      (p.ownerType = 'user' AND (
        p.ownerId = ?
        OR p.ownerId IN (
          SELECT CASE WHEN f.userA = ? THEN f.userB ELSE f.userA END
          FROM friendships f
          WHERE (f.userA = ? OR f.userB = ?) AND f.status = 'accepted'
        )
      ))
      OR
      (p.ownerType = 'group' AND p.ownerId IN (
        SELECT groupId FROM group_members WHERE userId = ?
      ))
    ORDER BY p.createdAt DESC
    LIMIT 50
  `)
};

// Одноразовая миграция: раньше пароли хранились в БД в открытом виде —
// на старте сервера хешируем всё, что ещё не похоже на "соль:хеш" (ничего
// не удаляет, просто переписывает колонку password). На следующих запусках
// уже нечего мигрировать — все пароли к тому моменту хешированы.
(function migratePlaintextPasswords() {
  const rows = db.prepare("SELECT id, password FROM users").all();
  let migrated = 0;
  for (const row of rows) {
    if (!PASSWORD_HASH_RE.test(row.password)) {
      stmts.updatePassword.run(hashPassword(row.password), row.id);
      migrated++;
    }
  }
  if (migrated > 0) console.log(`🔒 Пароли ${migrated} пользователей переведены на хеш (scrypt).`);
})();

// В friendships пара id всегда хранится как (меньший, больший), чтобы
// не завести одновременно (A,B) и (B,A) для одной и той же дружбы.
function friendPair(idA, idB) {
  return idA < idB ? [idA, idB] : [idB, idA];
}

// Отображаемое имя — то, что задаётся на "Мой аккаунт" и видно всем
// остальным; login остаётся фиксированным техническим идентификатором
// (уникальность, вход, WS) и в UI отдельно не редактируется.
function displayNameOf(user) {
  return (user && (user.displayName || user.login)) || "?";
}

function toPublicUser(user) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName || "",
    avatarUrl: user.avatarUrl,
    about: user.about || "",
    isAdmin: !!user.isAdmin
  };
}

// Расширенная карточка пользователя — только для админки (там, где не
// вредно показать isBanned/createdAt, в обычных публичных ручках это лишнее).
function toAdminUser(user) {
  return {
    ...toPublicUser(user),
    isBanned: !!user.isBanned,
    createdAt: user.createdAt || null
  };
}

function toMessagePayload(row) {
  return {
    id: row.id,
    room: row.room, from: row.fromLogin, fromDisplayName: row.fromDisplayName || row.fromLogin,
    text: row.text, avatar: row.avatar, ts: row.ts,
    fileUrl: row.fileUrl || null, fileName: row.fileName || null,
    pollData: row.pollData ? JSON.parse(row.pollData) : null,
    checklistData: row.checklistData ? JSON.parse(row.checklistData) : null
  };
}

function toPostPayload(post, userId) {
  const author = stmts.findUserById.get(post.authorId);
  return {
    id: post.id,
    ownerType: post.ownerType,
    ownerId: post.ownerId,
    authorId: post.authorId,
    authorName: displayNameOf(author),
    authorAvatar: author ? author.avatarUrl : "",
    text: post.text,
    photoUrl: post.photoUrl || null,
    createdAt: post.createdAt,
    likesCount: stmts.countLikes.get(post.id).c,
    commentsCount: stmts.countComments.get(post.id).c,
    likedByMe: !!stmts.findLike.get(post.id, userId),
    moderationStatus: post.moderationStatus || "clean",
    moderationReason: post.moderationReason || null
  };
}

function toCommentPayload(comment) {
  const author = stmts.findUserById.get(comment.authorId);
  return {
    id: comment.id,
    postId: comment.postId,
    authorId: comment.authorId,
    authorName: displayNameOf(author),
    authorAvatar: author ? author.avatarUrl : "",
    text: comment.text,
    photoUrl: comment.photoUrl || null,
    createdAt: comment.createdAt,
    moderationStatus: comment.moderationStatus || "clean",
    moderationReason: comment.moderationReason || null
  };
}

// Скрывает помеченные модерацией посты/комментарии от всех, кроме автора и
// админа — сам контент при этом остаётся в БД (не удаляется), просто не
// попадает в выдачу до ручного одобрения в админке (см. /api/admin/moderation).
function filterVisible(rows, userId, isAdmin, authorField) {
  if (isAdmin) return rows;
  return rows.filter((r) => r.moderationStatus !== "flagged" || r[authorField] === userId);
}

function toGroupPayload(group) {
  return {
    id: group.id,
    name: group.name,
    description: group.description,
    avatarUrl: group.avatarUrl,
    ownerId: group.ownerId,
    createdAt: group.createdAt,
    membersCount: stmts.countMembers.get(group.id).c
  };
}

// Middleware проверки JWT: ожидает заголовок "Authorization: Bearer <token>"
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || !token) {
    return res.status(401).json({ error: "Требуется авторизация" });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // Каждый запрос сверяет актуальное состояние в БД, а не то, что было
    // зашито в токен при выдаче — иначе бан или снятие прав админа не
    // подействуют, пока у человека не истечёт (или он не перевыпустит)
    // 7-дневный токен.
    const user = stmts.findUserById.get(payload.id);
    if (!user) return res.status(401).json({ error: "Пользователь не найден" });
    if (user.isBanned) return res.status(403).json({ error: "Аккаунт заблокирован" });
    req.user = { id: user.id, login: user.login, isAdmin: !!user.isAdmin };
    next();
  } catch (e) {
    return res.status(401).json({ error: "Недействительный или истёкший токен" });
  }
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) {
    return res.status(403).json({ error: "Требуются права администратора" });
  }
  next();
}

// API
app.post("/api/register", (req, res) => {
  const { login, password, avatarUrl } = req.body;
  try {
    if (!login || !password) return res.status(400).json({ error: "Укажи логин и пароль" });
    const existing = stmts.findUserByLogin.get(login);
    if (existing) return res.status(400).json({ error: "Логин занят" });
    const user = { id: generateUserId(), login, password: hashPassword(password), avatarUrl: avatarUrl || "", isAdmin: 0, createdAt: Date.now() };
    stmts.insertUser.run(user.id, user.login, user.password, user.avatarUrl, user.createdAt);
    const token = jwt.sign(
      { id: user.id, login: user.login, isAdmin: false },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ ...toPublicUser(user), token });
  } catch (e) { res.status(500).json({ error: "Ошибка регистрации" }); }
});

app.post("/api/login", (req, res) => {
  const { login, password } = req.body;
  try {
    const user = stmts.findUserByLogin.get(login);
    if (!user || !verifyPassword(password, user.password)) {
      return res.status(401).json({ error: "Неверные данные" });
    }
    if (user.isBanned) return res.status(403).json({ error: "Аккаунт заблокирован администратором" });
    const token = jwt.sign(
      { id: user.id, login: user.login, isAdmin: !!user.isAdmin },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN }
    );
    res.json({ ...toPublicUser(user), token });
  } catch (e) { res.status(500).json({ error: "Ошибка входа" }); }
});

// Возвращает данные текущего пользователя по токену
app.get("/api/me", requireAuth, (req, res) => {
  try {
    const user = stmts.findUserById.get(req.user.id);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    res.json(toPublicUser(user));
  } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

// Обновление своего профиля (фото, "о себе", отображаемое имя) — раньше это
// сохранялось только в localStorage и не было видно другим пользователям
// нигде (чат, посты, поиск друзей и т.д.), теперь пишем по-настоящему в БД.
// displayName — это НЕ login: login остаётся фиксированным (уникальность,
// вход, WS-идентификация), displayName — то, что видят остальные в UI.
app.patch("/api/me", requireAuth, (req, res) => {
  try {
    const current = stmts.findUserById.get(req.user.id);
    if (!current) return res.status(404).json({ error: "Пользователь не найден" });
    const { avatarUrl, about, displayName } = req.body;
    const nextAvatar = typeof avatarUrl === "string" ? avatarUrl.trim() : current.avatarUrl;
    const nextAbout = typeof about === "string" ? about.trim() : current.about;
    const nextDisplayName = typeof displayName === "string" ? displayName.trim().slice(0, 60) : current.displayName;
    stmts.updateUserProfile.run(nextAvatar, nextAbout, nextDisplayName, req.user.id);
    res.json(toPublicUser(stmts.findUserById.get(req.user.id)));
  } catch (e) { res.status(500).json({ error: "Ошибка обновления профиля" }); }
});

// ===== Пользователи: поиск и просмотр чужого профиля =====

app.get("/api/user-by-id/:id", requireAuth, (req, res) => {
  try {
    const user = stmts.findUserById.get(req.params.id);
    if (!user) return res.status(404).json({ error: "Пользователь не найден" });
    res.json(toPublicUser(user));
  } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

app.get("/api/users", requireAuth, (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    if (!q) return res.json([]);
    const rows = stmts.searchUsers.all(`%${q}%`, q, req.user.id);
    res.json(rows.map(toPublicUser));
  } catch (e) { res.status(500).json({ error: "Ошибка поиска" }); }
});

// Общая загрузка файла (фото к посту, файл в чат) — сначала загрузить сюда,
// затем использовать вернувшийся url в /api/posts или в WS-сообщении чата.
app.post("/api/upload", requireAuth, uploadAny.single("file"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Файл не выбран или запрещённый тип файла" });
  const fakeImageError = rejectIfFakeImage(req.file);
  if (fakeImageError) return res.status(400).json({ error: fakeImageError });
  res.json({
    url: `/uploads/${req.file.filename}`,
    filename: req.file.filename,
    originalName: fixFilenameEncoding(req.file.originalname),
    mimetype: req.file.mimetype,
    size: req.file.size
  });
});

// ===== Стена: посты, лайки, комментарии =====

app.post("/api/posts", requireAuth, (req, res) => {
  try {
    const { ownerType, ownerId, text, photoUrl } = req.body;
    const trimmed = (text || "").trim();
    const photo = typeof photoUrl === "string" && photoUrl.startsWith("/uploads/") ? photoUrl : null;
    if (!trimmed && !photo) return res.status(400).json({ error: "Пустой пост" });
    if (ownerType === "user") {
      const target = stmts.findUserById.get(ownerId);
      if (!target) return res.status(404).json({ error: "Профиль не найден" });
      if (ownerId !== req.user.id) return res.status(403).json({ error: "Можно постить только на свою стену" });
    } else if (ownerType === "group") {
      const target = stmts.findGroupById.get(ownerId);
      if (!target) return res.status(404).json({ error: "Группа не найдена" });
      if (!stmts.findMember.get(ownerId, req.user.id)) return res.status(403).json({ error: "Нужно быть участником группы" });
    } else {
      return res.status(400).json({ error: "Некорректный тип стены" });
    }
    const verdict = moderateText(trimmed);
    if (verdict.action === "reject") {
      return res.status(400).json({ error: "Публикация отклонена автомодерацией: " + verdict.reasons.join(", ") });
    }
    const id = crypto.randomUUID();
    const moderationStatus = verdict.action === "flag" ? "flagged" : "clean";
    const moderationReason = verdict.action === "flag" ? verdict.reasons.join(", ") : null;
    stmts.insertPost.run(id, ownerType, ownerId, req.user.id, trimmed, photo, Date.now(), moderationStatus, moderationReason);
    res.json(toPostPayload(stmts.findPostById.get(id), req.user.id));
  } catch (e) { res.status(500).json({ error: "Ошибка публикации" }); }
});

app.get("/api/posts", requireAuth, (req, res) => {
  try {
    const { ownerType, ownerId } = req.query;
    if (!ownerType || !ownerId) return res.status(400).json({ error: "Не указана стена" });
    const rows = filterVisible(stmts.listPosts.all(ownerType, ownerId), req.user.id, req.user.isAdmin, "authorId");
    res.json(rows.map(p => toPostPayload(p, req.user.id)));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки стены" }); }
});

app.delete("/api/posts/:id", requireAuth, (req, res) => {
  try {
    const post = stmts.findPostById.get(req.params.id);
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    let allowed = post.authorId === req.user.id || !!req.user.isAdmin;
    if (!allowed && post.ownerType === "user") allowed = post.ownerId === req.user.id;
    if (!allowed && post.ownerType === "group") {
      const group = stmts.findGroupById.get(post.ownerId);
      allowed = !!group && group.ownerId === req.user.id;
    }
    if (!allowed) return res.status(403).json({ error: "Нет прав на удаление" });
    stmts.deleteCommentsForPost.run(post.id);
    stmts.deleteLikesForPost.run(post.id);
    stmts.deletePost.run(post.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления" }); }
});

app.post("/api/posts/:id/like", requireAuth, (req, res) => {
  try {
    const post = stmts.findPostById.get(req.params.id);
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    const existing = stmts.findLike.get(post.id, req.user.id);
    if (existing) stmts.unlikePost.run(post.id, req.user.id);
    else stmts.likePost.run(post.id, req.user.id, Date.now());
    res.json({ likesCount: stmts.countLikes.get(post.id).c, likedByMe: !existing });
  } catch (e) { res.status(500).json({ error: "Ошибка лайка" }); }
});

app.get("/api/posts/:id/comments", requireAuth, (req, res) => {
  try {
    const post = stmts.findPostById.get(req.params.id);
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    const rows = filterVisible(stmts.listComments.all(post.id), req.user.id, req.user.isAdmin, "authorId");
    res.json(rows.map(toCommentPayload));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки комментариев" }); }
});

app.post("/api/posts/:id/comments", requireAuth, (req, res) => {
  try {
    const post = stmts.findPostById.get(req.params.id);
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    const trimmed = (req.body.text || "").trim();
    const photoUrl = typeof req.body.photoUrl === "string" && req.body.photoUrl.startsWith("/uploads/")
      ? req.body.photoUrl
      : null;
    if (!trimmed && !photoUrl) return res.status(400).json({ error: "Пустой комментарий" });
    const verdict = moderateText(trimmed);
    if (verdict.action === "reject") {
      return res.status(400).json({ error: "Комментарий отклонён автомодерацией: " + verdict.reasons.join(", ") });
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const moderationStatus = verdict.action === "flag" ? "flagged" : "clean";
    const moderationReason = verdict.action === "flag" ? verdict.reasons.join(", ") : null;
    stmts.insertComment.run(id, post.id, req.user.id, trimmed, photoUrl, createdAt, moderationStatus, moderationReason);
    res.json(toCommentPayload({ id, postId: post.id, authorId: req.user.id, text: trimmed, photoUrl, createdAt, moderationStatus, moderationReason }));
  } catch (e) { res.status(500).json({ error: "Ошибка комментария" }); }
});

app.delete("/api/comments/:id", requireAuth, (req, res) => {
  try {
    const comment = stmts.findCommentById.get(req.params.id);
    if (!comment) return res.status(404).json({ error: "Комментарий не найден" });
    if (comment.authorId !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: "Нет прав на удаление" });
    }
    stmts.deleteCommentRow.run(comment.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления" }); }
});

// ===== Друзья =====

app.post("/api/friends/request/:userId", requireAuth, (req, res) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.user.id) return res.status(400).json({ error: "Нельзя добавить себя в друзья" });
    if (!stmts.findUserById.get(targetId)) return res.status(404).json({ error: "Пользователь не найден" });
    const [a, b] = friendPair(req.user.id, targetId);
    const existing = stmts.findFriendship.get(a, b);
    if (existing) {
      return res.status(400).json({ error: existing.status === "accepted" ? "Вы уже друзья" : "Заявка уже отправлена" });
    }
    stmts.insertFriendship.run(crypto.randomUUID(), a, b, "pending", req.user.id, Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка заявки" }); }
});

app.post("/api/friends/accept/:userId", requireAuth, (req, res) => {
  try {
    const fromId = req.params.userId;
    const [a, b] = friendPair(req.user.id, fromId);
    const existing = stmts.findFriendship.get(a, b);
    if (!existing || existing.status !== "pending" || existing.requestedBy !== fromId) {
      return res.status(400).json({ error: "Такой заявки нет" });
    }
    stmts.acceptFriendship.run(a, b);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка подтверждения" }); }
});

app.post("/api/friends/decline/:userId", requireAuth, (req, res) => {
  try {
    const [a, b] = friendPair(req.user.id, req.params.userId);
    stmts.deleteFriendship.run(a, b);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

app.get("/api/friends", requireAuth, (req, res) => {
  try {
    const rows = stmts.listFriends.all(req.user.id, req.user.id, req.user.id);
    res.json(rows.map(toPublicUser));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки друзей" }); }
});

app.get("/api/friends/requests", requireAuth, (req, res) => {
  try {
    const rows = stmts.listIncomingRequests.all(req.user.id, req.user.id, req.user.id, req.user.id);
    res.json(rows.map(toPublicUser));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки заявок" }); }
});

app.get("/api/friends/subscriptions", requireAuth, (req, res) => {
  try {
    const rows = stmts.listOutgoingRequests.all(req.user.id, req.user.id, req.user.id, req.user.id);
    res.json(rows.map(toPublicUser));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки подписок" }); }
});

app.get("/api/friends/status/:userId", requireAuth, (req, res) => {
  try {
    const targetId = req.params.userId;
    if (targetId === req.user.id) return res.json({ status: "self" });
    const [a, b] = friendPair(req.user.id, targetId);
    const row = stmts.findFriendship.get(a, b);
    if (!row) return res.json({ status: "none" });
    if (row.status === "accepted") return res.json({ status: "friends" });
    res.json({ status: row.requestedBy === req.user.id ? "outgoing" : "incoming" });
  } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

// ===== Группы =====

app.post("/api/groups", requireAuth, (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    if (!name) return res.status(400).json({ error: "Укажи название группы" });
    const description = (req.body.description || "").trim();
    const avatarUrl = (req.body.avatarUrl || "").trim();
    const id = crypto.randomUUID();
    const now = Date.now();
    stmts.insertGroup.run(id, name, description, avatarUrl, req.user.id, now);
    stmts.insertMember.run(id, req.user.id, "owner", now);
    res.json(toGroupPayload(stmts.findGroupById.get(id)));
  } catch (e) { res.status(500).json({ error: "Ошибка создания группы" }); }
});

app.get("/api/groups", requireAuth, (req, res) => {
  try {
    res.json(stmts.listGroups.all().map(toGroupPayload));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки групп" }); }
});

app.get("/api/groups/:id", requireAuth, (req, res) => {
  try {
    const group = stmts.findGroupById.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Группа не найдена" });
    const member = stmts.findMember.get(group.id, req.user.id);
    res.json({ ...toGroupPayload(group), myRole: member ? member.role : null });
  } catch (e) { res.status(500).json({ error: "Ошибка" }); }
});

app.post("/api/groups/:id/join", requireAuth, (req, res) => {
  try {
    const group = stmts.findGroupById.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Группа не найдена" });
    stmts.insertMember.run(group.id, req.user.id, "member", Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка вступления" }); }
});

app.post("/api/groups/:id/leave", requireAuth, (req, res) => {
  try {
    const group = stmts.findGroupById.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Группа не найдена" });
    if (group.ownerId === req.user.id) return res.status(400).json({ error: "Владелец не может выйти из своей группы" });
    stmts.deleteMember.run(group.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка выхода" }); }
});

app.delete("/api/groups/:id", requireAuth, (req, res) => {
  try {
    const group = stmts.findGroupById.get(req.params.id);
    if (!group) return res.status(404).json({ error: "Группа не найдена" });
    if (group.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Нет прав на удаление" });
    stmts.deletePostsForOwner.run("group", group.id);
    stmts.deleteMembersForGroup.run(group.id);
    stmts.deleteGroup.run(group.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления группы" }); }
});

// ===== Фотоальбомы =====

app.post("/api/albums", requireAuth, (req, res) => {
  try {
    const title = (req.body.title || "Без названия").trim();
    const id = crypto.randomUUID();
    stmts.insertAlbum.run(id, req.user.id, title, Date.now());
    res.json(stmts.findAlbumById.get(id));
  } catch (e) { res.status(500).json({ error: "Ошибка создания альбома" }); }
});

app.get("/api/albums/:userId", requireAuth, (req, res) => {
  try {
    res.json(stmts.listAlbumsByOwner.all(req.params.userId));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки альбомов" }); }
});

function checkAlbumOwnership(req, res, next) {
  const album = stmts.findAlbumById.get(req.params.albumId);
  if (!album) return res.status(404).json({ error: "Альбом не найден" });
  if (album.ownerId !== req.user.id) return res.status(403).json({ error: "Это не ваш альбом" });
  req.album = album;
  next();
}

app.post("/api/albums/:albumId/photos", requireAuth, checkAlbumOwnership, upload.single("photo"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Нужен файл изображения" });
    const fakeImageError = rejectIfFakeImage(req.file);
    if (fakeImageError) return res.status(400).json({ error: fakeImageError });
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    const originalName = fixFilenameEncoding(req.file.originalname);
    stmts.insertPhoto.run(id, req.album.id, req.user.id, req.file.filename, originalName, createdAt);
    res.json({
      id, albumId: req.album.id, ownerId: req.user.id,
      filename: req.file.filename, originalName, createdAt,
      url: `/uploads/${req.file.filename}`
    });
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки фото" }); }
});

app.get("/api/albums/:albumId/photos", requireAuth, (req, res) => {
  try {
    const rows = stmts.listPhotosByAlbum.all(req.params.albumId);
    res.json(rows.map(p => ({ ...p, url: `/uploads/${p.filename}` })));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки фото" }); }
});

app.delete("/api/photos/:id", requireAuth, (req, res) => {
  try {
    const photo = stmts.findPhotoById.get(req.params.id);
    if (!photo) return res.status(404).json({ error: "Фото не найдено" });
    if (photo.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Это не ваше фото" });
    fs.unlink(path.join(UPLOADS_DIR, photo.filename), () => {});
    stmts.deletePhoto.run(photo.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления фото" }); }
});

// ===== Истории (сторис) — живут 24 часа, потом удаляются =====

const STORY_TTL_MS = 24 * 60 * 60 * 1000;

app.post("/api/stories", requireAuth, (req, res) => {
  try {
    const { photoUrl } = req.body;
    if (typeof photoUrl !== "string" || !photoUrl.startsWith("/uploads/")) {
      return res.status(400).json({ error: "Нужно фото" });
    }
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    stmts.insertStory.run(id, req.user.id, photoUrl, createdAt);
    res.json({ id, ownerId: req.user.id, photoUrl, createdAt });
  } catch (e) { res.status(500).json({ error: "Ошибка публикации истории" }); }
});

app.get("/api/stories", requireAuth, (req, res) => {
  try {
    const cutoff = Date.now() - STORY_TTL_MS;
    stmts.deleteExpiredStories.run(cutoff); // ленивая чистка вместо крона — ок при таком объёме данных
    const rows = stmts.listActiveStories.all(cutoff);
    res.json(rows.map(r => ({
      id: r.id, ownerId: r.ownerId, photoUrl: r.photoUrl, createdAt: r.createdAt,
      ownerLogin: r.ownerLogin, ownerAvatar: r.ownerAvatar
    })));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки историй" }); }
});

app.delete("/api/stories/:id", requireAuth, (req, res) => {
  try {
    const story = stmts.findStoryById.get(req.params.id);
    if (!story) return res.status(404).json({ error: "История не найдена" });
    if (story.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Не ваша история" });
    stmts.deleteStory.run(story.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления" }); }
});

// ===== Лента (Главная) =====

app.get("/api/feed", requireAuth, (req, res) => {
  try {
    const rawRows = stmts.feedPosts.all(req.user.id, req.user.id, req.user.id, req.user.id, req.user.id);
    const rows = filterVisible(rawRows, req.user.id, req.user.isAdmin, "authorId");
    const payload = rows.map((p) => {
      const post = toPostPayload(p, req.user.id);
      if (p.ownerType === "group") {
        const group = stmts.findGroupById.get(p.ownerId);
        post.contextLabel = group ? group.name : null;
      } else if (p.ownerId !== req.user.id) {
        const owner = stmts.findUserById.get(p.ownerId);
        post.contextLabel = owner ? displayNameOf(owner) : null;
      } else {
        post.contextLabel = null;
      }
      return post;
    });
    res.json(payload);
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки ленты" }); }
});

// ===== Админка =====
// Всё за requireAuth + requireAdmin. Помимо этого requireAuth сам по себе
// уже не пускает забаненных и берёт isAdmin свежим из БД на каждый запрос
// (см. requireAuth выше) — так что и бан, и снятие прав применяются сразу,
// без ожидания протухания токена.

app.get("/api/admin/stats", requireAuth, requireAdmin, (req, res) => {
  try {
    res.json({
      users: stmts.countUsers.get().c,
      admins: stmts.countAdmins.get().c,
      banned: stmts.countBanned.get().c,
      posts: stmts.countAllPosts.get().c,
      comments: stmts.countAllComments.get().c,
      messages: stmts.countAllMessages.get().c,
      groups: stmts.countAllGroups.get().c,
      photos: stmts.countAllPhotos.get().c,
      stories: stmts.countAllStories.get().c
    });
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки статистики" }); }
});

app.get("/api/admin/users", requireAuth, requireAdmin, (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const rows = stmts.listAllUsers.all(`%${q}%`);
    res.json(rows.map(toAdminUser));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки пользователей" }); }
});

app.patch("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    const target = stmts.findUserById.get(req.params.id);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });
    if (target.id === req.user.id && req.body.isAdmin === false) {
      return res.status(400).json({ error: "Нельзя снять права администратора с самого себя" });
    }
    if (typeof req.body.isAdmin === "boolean") {
      stmts.setUserAdmin.run(req.body.isAdmin ? 1 : 0, target.id);
    }
    if (typeof req.body.isBanned === "boolean") {
      if (target.id === req.user.id && req.body.isBanned) {
        return res.status(400).json({ error: "Нельзя забанить самого себя" });
      }
      stmts.setUserBanned.run(req.body.isBanned ? 1 : 0, target.id);
    }
    res.json(toAdminUser(stmts.findUserById.get(target.id)));
  } catch (e) { res.status(500).json({ error: "Ошибка обновления пользователя" }); }
});

app.delete("/api/admin/users/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    if (req.params.id === req.user.id) {
      return res.status(400).json({ error: "Нельзя удалить самого себя" });
    }
    const target = stmts.findUserById.get(req.params.id);
    if (!target) return res.status(404).json({ error: "Пользователь не найден" });

    // Группы, которыми он владеет, — целиком, иначе останутся без хозяина.
    stmts.findGroupIdsByOwner.all(target.id).forEach((g) => {
      stmts.deletePostsForOwner.run("group", g.id);
      stmts.deleteMembersForGroup.run(g.id);
      stmts.deleteGroup.run(g.id);
    });

    // Посты (свои и авторство на чужих/групповых стенах) вместе с их
    // комментариями/лайками, плюс его комментарии/лайки на чужих постах.
    stmts.findPostIdsByAuthor.all(target.id).forEach((p) => {
      stmts.deleteCommentsForPost.run(p.id);
      stmts.deleteLikesForPost.run(p.id);
    });
    stmts.deletePostsByAuthor.run(target.id);
    stmts.deleteCommentsByAuthor.run(target.id);
    stmts.deleteLikesByUser.run(target.id);

    // Фото и альбомы — с файлами на диске.
    stmts.findPhotosByOwner.all(target.id).forEach((p) => {
      fs.unlink(path.join(UPLOADS_DIR, p.filename), () => {});
      stmts.deletePhotoRow.run(p.id);
    });
    stmts.findAlbumIdsByOwner.all(target.id).forEach((a) => stmts.deleteAlbumRow.run(a.id));
    stmts.deleteStoriesByOwner.run(target.id);

    stmts.deleteFriendshipsByUser.run(target.id, target.id);
    stmts.deleteGroupMembershipsByUser.run(target.id);
    stmts.deleteUser.run(target.id);

    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления пользователя" }); }
});

app.get("/api/admin/posts", requireAuth, requireAdmin, (req, res) => {
  try {
    const q = (req.query.q || "").trim();
    const rows = stmts.listRecentPosts.all(`%${q}%`);
    res.json(rows.map((p) => {
      const post = toPostPayload(p, req.user.id);
      if (p.ownerType === "group") {
        const group = stmts.findGroupById.get(p.ownerId);
        post.contextLabel = group ? group.name : null;
      } else {
        const owner = stmts.findUserById.get(p.ownerId);
        post.contextLabel = owner ? displayNameOf(owner) : null;
      }
      return post;
    }));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки постов" }); }
});

// Очередь автомодерации: посты/комментарии, которые локальный фильтр
// (moderation.js) пометил как подозрительные при публикации (score 30-79 —
// ниже жёсткого порога отклонения, но не совсем чисто). Видны только
// админу — обычным пользователям и автору такие посты/комментарии не
// показываются в ленте/на стене (см. filterVisible), пока админ не
// одобрит их либо не удалит существующими DELETE-роутами.
app.get("/api/admin/moderation", requireAuth, requireAdmin, (req, res) => {
  try {
    const posts = stmts.listFlaggedPosts.all().map((p) => {
      const post = toPostPayload(p, req.user.id);
      if (p.ownerType === "group") {
        const group = stmts.findGroupById.get(p.ownerId);
        post.contextLabel = group ? group.name : null;
      } else {
        const owner = stmts.findUserById.get(p.ownerId);
        post.contextLabel = owner ? displayNameOf(owner) : null;
      }
      return post;
    });
    const comments = stmts.listFlaggedComments.all().map(toCommentPayload);
    res.json({ posts, comments });
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки очереди модерации" }); }
});

app.patch("/api/admin/posts/:id/approve", requireAuth, requireAdmin, (req, res) => {
  try {
    const post = stmts.findPostById.get(req.params.id);
    if (!post) return res.status(404).json({ error: "Пост не найден" });
    stmts.approvePost.run(post.id);
    res.json(toPostPayload(stmts.findPostById.get(post.id), req.user.id));
  } catch (e) { res.status(500).json({ error: "Ошибка одобрения поста" }); }
});

app.patch("/api/admin/comments/:id/approve", requireAuth, requireAdmin, (req, res) => {
  try {
    const comment = stmts.findCommentById.get(req.params.id);
    if (!comment) return res.status(404).json({ error: "Комментарий не найден" });
    stmts.approveComment.run(comment.id);
    res.json(toCommentPayload(stmts.findCommentById.get(comment.id)));
  } catch (e) { res.status(500).json({ error: "Ошибка одобрения комментария" }); }
});

app.get("/api/admin/groups", requireAuth, requireAdmin, (req, res) => {
  try {
    res.json(stmts.listAllGroupsAdmin.all().map(toGroupPayload));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки групп" }); }
});

// ===== Карточки комнат чата ("Информация о группе"/"Управление группой") =====
// Комната чата — просто строка-id, к которой можно подключиться по WS,
// ничего не регистрируя (так и работал весь чат до этого). Эта таблица —
// ОПЦИОНАЛЬНАЯ карточка поверх такой комнаты (имя/аватар/владелец),
// регистрируется на клиенте при создании через "+ Комната". У комнат без
// карточки (например "public") эти пункты меню просто не показываются.
app.post("/api/chat-rooms", requireAuth, (req, res) => {
  try {
    const { id, name } = req.body;
    if (!id || !name) return res.status(400).json({ error: "Не указано имя или id комнаты" });
    const existing = stmts.findChatRoom.get(id);
    if (existing) return res.json(existing);
    stmts.insertChatRoom.run(id, String(name).trim().slice(0, 80), "", req.user.id, Date.now());
    res.json(stmts.findChatRoom.get(id));
  } catch (e) { res.status(500).json({ error: "Ошибка регистрации комнаты" }); }
});

app.get("/api/chat-rooms/:id", requireAuth, (req, res) => {
  try {
    const room = stmts.findChatRoom.get(req.params.id);
    if (!room) return res.status(404).json({ error: "Комната не зарегистрирована" });
    const owner = stmts.findUserById.get(room.ownerId);
    res.json({ ...room, ownerName: owner ? displayNameOf(owner) : "?" });
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки комнаты" }); }
});

app.patch("/api/chat-rooms/:id", requireAuth, (req, res) => {
  try {
    const room = stmts.findChatRoom.get(req.params.id);
    if (!room) return res.status(404).json({ error: "Комната не зарегистрирована" });
    if (room.ownerId !== req.user.id && !req.user.isAdmin) {
      return res.status(403).json({ error: "Управлять комнатой может только её создатель" });
    }
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim().slice(0, 80) : room.name;
    const avatarUrl = typeof req.body.avatarUrl === "string" ? req.body.avatarUrl.trim() : room.avatarUrl;
    stmts.updateChatRoom.run(name, avatarUrl, room.id);
    const updated = stmts.findChatRoom.get(room.id);
    // сообщаем всем, кто сейчас подключён к комнате, — обновить у себя имя/аватар
    clients.forEach((c) => {
      if (c.room === room.id && c.ws.readyState === 1) {
        c.ws.send(JSON.stringify({ type: "roomUpdate", room: room.id, name: updated.name, avatarUrl: updated.avatarUrl }));
      }
    });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: "Ошибка обновления комнаты" }); }
});

// ===== Жалобы на переписку =====
app.post("/api/chat-reports", requireAuth, (req, res) => {
  try {
    const room = (req.body.room || "").trim();
    const note = (req.body.note || "").trim().slice(0, 500);
    if (!room) return res.status(400).json({ error: "Не указана комната" });
    stmts.insertChatReport.run(crypto.randomUUID(), room, req.user.id, note, Date.now());
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка отправки жалобы" }); }
});

app.get("/api/admin/chat-reports", requireAuth, requireAdmin, (req, res) => {
  try {
    const rows = stmts.listChatReports.all().map((r) => {
      const reporter = stmts.findUserById.get(r.reporterId);
      return { ...r, reporterName: reporter ? displayNameOf(reporter) : r.reporterId };
    });
    res.json(rows);
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки жалоб" }); }
});

app.delete("/api/admin/chat-reports/:id", requireAuth, requireAdmin, (req, res) => {
  try {
    stmts.deleteChatReport.run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления жалобы" }); }
});

// Ошибки multer (например, превышен лимит размера файла) не должны улетать
// в дефолтный HTML-обработчик ошибок Express — отвечаем тем же JSON-форматом.
app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: "Ошибка загрузки файла: " + err.message });
  next();
});

// WebSocket с поддержкой истории
const wss = new WebSocketServer({ server, path: "/ws" });
const clients = new Set();

// Реальное число людей, СЕЙЧАС подключённых к этой комнате (по логину, без
// дублей — если у кого-то открыто две вкладки, считается один раз). Это не
// "участники беседы" в смысле членства (такой сущности в модели чата нет —
// комната это просто строка, к которой можно подключиться), а честный live
// счётчик "кто прямо сейчас смотрит в этот чат", который и показываем в
// шапке чата вместо выдуманного числа участников.
function broadcastPresence(room) {
  const logins = new Set();
  clients.forEach((c) => { if (c.room === room && c.ws.readyState === 1) logins.add(c.login); });
  const payload = JSON.stringify({ type: "presence", room, count: logins.size });
  clients.forEach((c) => { if (c.room === room && c.ws.readyState === 1) c.ws.send(payload); });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  const login = url.searchParams.get("login") || "Гость";
  let currentRoom = url.searchParams.get("room") || "public";

  // WS всё ещё не проверяет JWT (см. известную проблему в CLAUDE.md), но
  // забаненного хотя бы не пускаем писать в чат по логину.
  const connectingUser = stmts.findUserByLogin.get(login);
  if (connectingUser && connectingUser.isBanned) {
    ws.close(4003, "banned");
    return;
  }

  const client = { ws, login, room: currentRoom };
  clients.add(client);
  broadcastPresence(currentRoom);

  // Загрузка истории (последние 50)
  try {
    const history = stmts.lastMessages.all(currentRoom).reverse().map(toMessagePayload);
    ws.send(JSON.stringify({ type: "history", data: history }));
  } catch (err) { console.log(err); }

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === "chat") {
        const sender = stmts.findUserByLogin.get(client.login);
        const fileUrl = typeof msg.fileUrl === "string" && msg.fileUrl.startsWith("/uploads/") ? msg.fileUrl : null;
        const newMessage = {
          id: crypto.randomUUID(),
          room: currentRoom,
          fromLogin: client.login,
          fromDisplayName: displayNameOf(sender) !== "?" ? displayNameOf(sender) : client.login,
          text: msg.text || "",
          avatar: sender ? sender.avatarUrl : "",
          ts: Date.now(),
          fileUrl,
          fileName: fileUrl ? (msg.fileName || "файл") : null
        };
        stmts.insertMessage.run(
          newMessage.id, newMessage.room, newMessage.fromLogin, newMessage.text,
          newMessage.avatar, newMessage.ts, newMessage.fileUrl, newMessage.fileName,
          newMessage.fromDisplayName
        );

        const payload = toMessagePayload(newMessage);
        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "chat", ...payload }));
          }
        });
      }

      // Опрос — обычное сообщение чата с pollData вместо текста. Рендерится
      // клиентом как отдельный блок (см. app.js), голосование — msg "vote"
      // ниже, отдельно от создания.
      if (msg.type === "poll") {
        const question = (msg.question || "").trim().slice(0, 200);
        const options = Array.isArray(msg.options)
          ? msg.options.map((o) => (o || "").toString().trim().slice(0, 80)).filter(Boolean)
          : [];
        if (!question || options.length < 2) return;
        const sender = stmts.findUserByLogin.get(client.login);
        const pollData = JSON.stringify({ question, options: options.map((text) => ({ text, votes: [] })) });
        const newMessage = {
          id: crypto.randomUUID(),
          room: currentRoom,
          fromLogin: client.login,
          fromDisplayName: displayNameOf(sender) !== "?" ? displayNameOf(sender) : client.login,
          text: "",
          avatar: sender ? sender.avatarUrl : "",
          ts: Date.now(),
          fileUrl: null,
          fileName: null,
          pollData
        };
        stmts.insertMessage.run(
          newMessage.id, newMessage.room, newMessage.fromLogin, newMessage.text,
          newMessage.avatar, newMessage.ts, newMessage.fileUrl, newMessage.fileName,
          newMessage.fromDisplayName
        );
        stmts.updateMessagePoll.run(pollData, newMessage.id);

        const payload = toMessagePayload(newMessage);
        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "chat", ...payload }));
          }
        });
      }

      // Голос в опросе — однократный выбор: голос переносится из старого
      // варианта в новый, если человек передумал.
      if (msg.type === "vote") {
        const message = stmts.findMessageById.get(msg.messageId);
        if (!message || !message.pollData || message.room !== currentRoom) return;
        let poll;
        try { poll = JSON.parse(message.pollData); } catch (e) { return; }
        const optionIndex = msg.optionIndex;
        if (!Number.isInteger(optionIndex) || !poll.options[optionIndex]) return;
        poll.options.forEach((o) => { o.votes = o.votes.filter((l) => l !== client.login); });
        poll.options[optionIndex].votes.push(client.login);
        const updatedData = JSON.stringify(poll);
        stmts.updateMessagePoll.run(updatedData, message.id);

        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "pollUpdate", room: currentRoom, messageId: message.id, pollData: poll }));
          }
        });
      }

      // Список задач с чекбоксами — как обычный опрос, но каждый пункт
      // независимая галочка, а не взаимоисключающий выбор. Отмечать/снимать
      // отметку может ЛЮБОЙ участник комнаты (общий список задач, не "мой
      // голос") — состояние полностью shared, checkedBy только для отображения
      // "кто отметил последним".
      if (msg.type === "checklist") {
        const title = (msg.title || "").trim().slice(0, 200);
        const rawItems = Array.isArray(msg.items)
          ? msg.items.map((i) => (i || "").toString().trim().slice(0, 120)).filter(Boolean)
          : [];
        if (!title || rawItems.length < 1) return;
        const sender = stmts.findUserByLogin.get(client.login);
        const checklistData = JSON.stringify({
          title,
          items: rawItems.map((text) => ({ text, checked: false, checkedBy: null }))
        });
        const newMessage = {
          id: crypto.randomUUID(),
          room: currentRoom,
          fromLogin: client.login,
          fromDisplayName: displayNameOf(sender) !== "?" ? displayNameOf(sender) : client.login,
          text: "",
          avatar: sender ? sender.avatarUrl : "",
          ts: Date.now(),
          fileUrl: null,
          fileName: null,
          checklistData
        };
        stmts.insertMessage.run(
          newMessage.id, newMessage.room, newMessage.fromLogin, newMessage.text,
          newMessage.avatar, newMessage.ts, newMessage.fileUrl, newMessage.fileName,
          newMessage.fromDisplayName
        );
        stmts.updateMessageChecklist.run(checklistData, newMessage.id);

        const payload = toMessagePayload(newMessage);
        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "chat", ...payload }));
          }
        });
      }

      if (msg.type === "checklistToggle") {
        const message = stmts.findMessageById.get(msg.messageId);
        if (!message || !message.checklistData || message.room !== currentRoom) return;
        let checklist;
        try { checklist = JSON.parse(message.checklistData); } catch (e) { return; }
        const itemIndex = msg.itemIndex;
        if (!Number.isInteger(itemIndex) || !checklist.items[itemIndex]) return;
        const item = checklist.items[itemIndex];
        item.checked = !item.checked;
        // Отображаемое имя, не login — login технический и в UI не
        // показывается нигде в проекте (см. CLAUDE.md).
        const toggledBy = stmts.findUserByLogin.get(client.login);
        item.checkedBy = item.checked ? (displayNameOf(toggledBy) !== "?" ? displayNameOf(toggledBy) : client.login) : null;
        const updatedData = JSON.stringify(checklist);
        stmts.updateMessageChecklist.run(updatedData, message.id);

        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "checklistUpdate", room: currentRoom, messageId: message.id, checklistData: checklist }));
          }
        });
      }

      // Трекер времени на пункте списка — старт/стоп персонально для
      // каждого (у каждого свой накопленный totalSeconds), но видно всем
      // ("сколько у кого времени ушло"). runningSince — abs. timestamp
      // сервера, поэтому "сколько идёт прямо сейчас" клиент честно
      // досчитывает сам (Date.now() - runningSince), без рассинхрона часов.
      if (msg.type === "checklistTimerToggle") {
        const message = stmts.findMessageById.get(msg.messageId);
        if (!message || !message.checklistData || message.room !== currentRoom) return;
        let checklist;
        try { checklist = JSON.parse(message.checklistData); } catch (e) { return; }
        const itemIndex = msg.itemIndex;
        if (!Number.isInteger(itemIndex) || !checklist.items[itemIndex]) return;
        const item = checklist.items[itemIndex];
        if (!Array.isArray(item.timers)) item.timers = [];

        const sender = stmts.findUserByLogin.get(client.login);
        const displayName = sender && displayNameOf(sender) !== "?" ? displayNameOf(sender) : client.login;
        let entry = item.timers.find((t) => t.login === client.login);
        if (!entry) {
          entry = { login: client.login, displayName, totalSeconds: 0, runningSince: null };
          item.timers.push(entry);
        }
        entry.displayName = displayName; // на случай смены имени между сессиями

        if (entry.runningSince) {
          entry.totalSeconds += (Date.now() - entry.runningSince) / 1000;
          entry.runningSince = null;
        } else {
          entry.runningSince = Date.now();
        }

        const updatedData = JSON.stringify(checklist);
        stmts.updateMessageChecklist.run(updatedData, message.id);

        clients.forEach(c => {
          if (c.room === currentRoom && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "checklistUpdate", room: currentRoom, messageId: message.id, checklistData: checklist }));
          }
        });
      }

      // ===== Звонки (аудио/видео через WebRTC) =====
      // Голос/видео идёт НАПРЯМУЮ между браузерами (P2P) — сервер только
      // пересылает служебные сообщения для установки соединения (SDP
      // offer/answer, ICE-кандидаты) между двумя конкретными людьми, по
      // login, а НЕ по комнате — звонок не привязан к тому, какая комната
      // у кого сейчас открыта в WS (это разные, независимые вещи).
      // from/fromDisplayName/fromAvatar всегда берём из client.login
      // (то есть из самого WS-соединения), а не из тела сообщения — как
      // и везде в чате, звонящий не может выдать себя за другого.
      if (["call-offer", "call-answer", "call-ice", "call-reject", "call-end", "call-busy"].includes(msg.type)) {
        const toLogin = msg.to;
        if (!toLogin || !msg.callId) return;
        const sender = stmts.findUserByLogin.get(client.login);
        const payload = {
          type: msg.type,
          callId: msg.callId,
          to: toLogin,
          from: client.login,
          fromDisplayName: sender ? displayNameOf(sender) : client.login,
          fromAvatar: sender ? sender.avatarUrl : "",
          video: !!msg.video,
          sdp: msg.sdp,
          candidate: msg.candidate
        };
        let delivered = false;
        clients.forEach((c) => {
          if (c.login === toLogin && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify(payload));
            delivered = true;
          }
        });
        // Звонок, а собеседник вообще ни к чему не подключён — честно
        // сообщаем звонящему, что он не в сети, вместо гудков в пустоту.
        if (msg.type === "call-offer" && !delivered) {
          ws.send(JSON.stringify({ type: "call-unavailable", callId: msg.callId, to: toLogin }));
        }
        return;
      }
    } catch (e) { console.error(e); }
  });

  ws.on("close", () => {
    clients.delete(client);
    broadcastPresence(currentRoom);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
