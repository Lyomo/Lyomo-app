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
// За обратным прокси Render (и любым другим PaaS с прокси перед Node) —
// без этого req.secure/req.protocol всегда были бы "http", даже когда
// реальный внешний запрос пришёл по https. Нужно ниже для куки сайт-гейта
// (флаг Secure) и в целом безобидно, если приложение не за прокси (просто
// не используется).
app.set("trust proxy", 1);
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

// Логин — технический идентификатор (не отображаемое имя, см. displayName) —
// только латиница/цифры/точка/подчёркивание, без пробелов. Проверяется и на
// клиенте (auth.html), и здесь — сервер никогда не должен доверять клиентской
// валидации как единственной линии защиты.
const LOGIN_FORMAT_RE = /^[A-Za-z0-9_.]{3,32}$/;
const MIN_PASSWORD_LENGTH = 6;

// Имя/фамилия при регистрации — в отличие от логина, это реальное имя
// человека (любой алфавит), поэтому \p{L} (юникодная категория "буква"),
// плюс дефис и апостроф для составных имён ("Анна-Мария", "O'Brien").
// Складываются в единый users.displayName при регистрации — отдельных
// колонок firstName/lastName нет: displayName и так уже единственное
// редактируемое пользователем "видимое" имя везде в проекте (см. "Мой
// аккаунт"), заводить рядом второй, слабо связанный набор полей не стали.
const NAME_FORMAT_RE = /^\p{L}[\p{L}\-' ]{0,49}$/u;

// Категории групп — фиксированный список (не свободные теги, см. db.js).
// Ключи должны совпадать с value у <option>/чипов в groups.html — это
// единственное место, которое их валидирует, клиент просто отправляет то,
// что выбрано в <select>.
const GROUP_CATEGORY_KEYS = new Set(["it", "fun", "games", "education", "music", "movies", "other"]);
const DEFAULT_GROUP_CATEGORY = "other";

// Дата рождения — формат нативного <input type="date"> на клиенте
// ("YYYY-MM-DD"), проверяем и здесь тем же строковым regex, а не просто
// new Date(...), потому что new Date("2024-13-45") в JS не бросает
// исключение, а тихо даёт Invalid Date (уже отдельно проверяется ниже) —
// но регексп сразу отсеивает совсем не тот формат (например, DD.MM.YYYY).
const BIRTH_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MIN_REGISTRATION_AGE = 13;

// Возраст на сегодня по дате рождения "YYYY-MM-DD" — учитывает месяц/день,
// не просто разницу годов (иначе человек, которому исполнится 13 только
// через полгода, прошёл бы проверку уже сегодня).
function calculateAge(birthDateStr) {
  const [y, m, d] = birthDateStr.split("-").map(Number);
  const birth = new Date(y, m - 1, d);
  const now = new Date();
  let age = now.getFullYear() - birth.getFullYear();
  const monthDiff = now.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age--;
  return age;
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

// ===== Временная защита сайта общим паролем =====
// Пока проект не готов к публичному релизу, но уже висит на настоящем
// домене — просили закрыть буквально ВСЁ (включая саму страницу входа)
// одним общим логином/паролем поверх обычной системы аккаунтов. Включается
// только если заданы ОБЕ переменные окружения — если их нет (обычный
// локальный dev без .env-настройки этой пары), проверка просто не
// подключается, ничего не меняется в поведении. Это САМЫЙ ПЕРВЫЙ
// middleware — раньше cors()/статики/API, чтобы действительно ничего не
// отдавалось без пароля.
//
// [ИЗМЕНЕНО] Было HTTP Basic Auth (системное окошко браузера) — на
// мобильных (особенно iOS Safari, особенно в PWA-режиме "на главном
// экране") браузер ненадёжно кэширует Basic-заголовок для fetch/XHR-
// запросов, а это почти все запросы приложения (/api/*, WS-хендшейк) —
// окошко логина/пароля выскакивало заново почти на каждое действие,
// жаловался пользователь ("постоянно просит логин"). Теперь — свой HTML-
// экран с обычной формой (без alert/prompt, тот же принцип, что и везде
// в проекте) + подписанная HMAC-кука на 180 дней: куки браузер сам
// прикладывает к каждому запросу того же origin (включая fetch/WS),
// в отличие от Basic-заголовка это не завязано на отдельный
// браузерный кэш авторизации, который на мобильных вёл себя не так,
// как на десктопе.
const SITE_AUTH_USER = process.env.SITE_AUTH_USER;
const SITE_AUTH_PASS = process.env.SITE_AUTH_PASS;
const SITE_AUTH_COOKIE = "lomo_site_auth";
const SITE_AUTH_MAX_AGE_SEC = 180 * 24 * 60 * 60;

function siteGateHtml(showError) {
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>LÖMO</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: radial-gradient(circle at 20% 20%, #bbf7d0, transparent 45%),
                radial-gradient(circle at 80% 80%, #86efac, transparent 45%), #f4faf6;
    padding: 16px;
  }
  .card {
    width: 100%; max-width: 340px; background: #fff; border-radius: 16px;
    padding: 28px 24px; box-shadow: 0 10px 30px rgba(0,0,0,.12);
  }
  .logo {
    width: 48px; height: 48px; border-radius: 50%; margin: 0 auto 16px;
    display: flex; align-items: center; justify-content: center; color: #fff; font-weight: 700;
    background: radial-gradient(circle at 30% 30%, #fff, #86efac 45%, #16a34a);
  }
  h1 { font-size: 17px; text-align: center; margin: 0 0 20px; color: #14532d; }
  input {
    width: 100%; padding: 11px 12px; margin-bottom: 10px; border-radius: 10px;
    border: 1px solid #cbd5c9; font-size: 15px;
  }
  button {
    width: 100%; padding: 11px; border-radius: 10px; border: none; margin-top: 6px;
    background: #16a34a; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer;
  }
  .err { color: #dc2626; font-size: 13px; text-align: center; margin: 0 0 10px; }
</style>
</head>
<body>
  <form class="card" method="post" action="/site-auth">
    <div class="logo">LÖ</div>
    <h1>Сайт закрыт паролем доступа</h1>
    ${showError ? '<p class="err">Неверный логин или пароль</p>' : ""}
    <input name="user" placeholder="Логин" autocomplete="username" autofocus>
    <input name="pass" type="password" placeholder="Пароль" autocomplete="current-password">
    <button type="submit">Войти</button>
  </form>
</body>
</html>`;
}

function parseCookieHeader(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const eq = part.indexOf("=");
    if (eq < 0) return;
    out[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  });
  return out;
}

if (SITE_AUTH_USER && SITE_AUTH_PASS) {
  // Токен — детерминированный HMAC от самих SITE_AUTH_USER/PASS (не
  // случайный на процесс), иначе рестарт сервера (частый на Render, см.
  // "[КРИТИЧНО]" ниже про эфемерную файловую систему) разлогинивал бы всех
  // из сайт-гейта, хотя пароль не менялся.
  const validToken = crypto.createHmac("sha256", SITE_AUTH_PASS).update(`${SITE_AUTH_USER}:site-gate`).digest("hex");

  app.post("/site-auth", express.urlencoded({ extended: false }), (req, res) => {
    const user = (req.body && req.body.user) || "";
    const pass = (req.body && req.body.pass) || "";
    const userBuf = Buffer.from(user);
    const expectedUserBuf = Buffer.from(SITE_AUTH_USER);
    const passBuf = Buffer.from(pass);
    const expectedPassBuf = Buffer.from(SITE_AUTH_PASS);
    const userOk = userBuf.length === expectedUserBuf.length && crypto.timingSafeEqual(userBuf, expectedUserBuf);
    const passOk = passBuf.length === expectedPassBuf.length && crypto.timingSafeEqual(passBuf, expectedPassBuf);
    if (userOk && passOk) {
      const secure = req.secure || req.headers["x-forwarded-proto"] === "https";
      res.setHeader(
        "Set-Cookie",
        `${SITE_AUTH_COOKIE}=${encodeURIComponent(validToken)}; Max-Age=${SITE_AUTH_MAX_AGE_SEC}; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
      );
      return res.redirect(302, "/");
    }
    res.status(401).set("Content-Type", "text/html; charset=utf-8").send(siteGateHtml(true));
  });

  app.use((req, res, next) => {
    if (req.path === "/site-auth") return next();
    const cookies = parseCookieHeader(req.headers.cookie);
    const cookieVal = cookies[SITE_AUTH_COOKIE] || "";
    const cookieBuf = Buffer.from(cookieVal);
    const tokenBuf = Buffer.from(validToken);
    const ok = cookieBuf.length === tokenBuf.length && crypto.timingSafeEqual(cookieBuf, tokenBuf);
    if (ok) return next();
    res.status(401).set("Content-Type", "text/html; charset=utf-8").send(siteGateHtml(false));
  });

  console.log("🔒 Сайт закрыт общим паролем (заданы SITE_AUTH_USER/SITE_AUTH_PASS) — доступ через форму /site-auth, кука на 180 дней.");
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

// Для раздела "Музыка" — только звук, лимит поменьше видео.
const uploadAudio = multer({
  storage: uploadStorage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("audio/"))
});

// Для раздела "Видео" (свои файлы, не ссылки) — лимит больше остальных,
// это тяжёлые файлы; как и везде в проекте, без сигнатурной проверки
// содержимого (та есть только у картинок, см. isRealImage) — только
// mimetype на входе, тот же уровень строгости, что у общего /api/upload.
const uploadVideo = multer({
  storage: uploadStorage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith("video/"))
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
  insertUser: db.prepare("INSERT INTO users (id, login, password, avatarUrl, isAdmin, createdAt, termsAcceptedAt, displayName, birthDate) VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)"),
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
  // Без LIKE-фильтра в самом запросе — фильтрация по логину/имени теперь
  // делается в JS (см. /api/admin/users), потому что встроенный LIKE в
  // SQLite регистронезависим только для ASCII: "логин LIKE '%иван%'" не
  // находит "Иван" (кириллица не участвует в его case-folding), а обычный
  // JS .toLowerCase() кириллицу схлопывает корректно.
  listAllUsers: db.prepare("SELECT * FROM users ORDER BY (createdAt IS NULL), createdAt DESC"),
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

  // Членство в комнате (не DM, см. комментарий у CREATE TABLE в db.js) —
  // заводится при подключении по WS, удаляется явным "Покинуть".
  insertRoomMember: db.prepare("INSERT OR IGNORE INTO chat_room_members (roomId, userId, joinedAt) VALUES (?, ?, ?)"),
  deleteRoomMember: db.prepare("DELETE FROM chat_room_members WHERE roomId = ? AND userId = ?"),
  listRoomMembers: db.prepare(`
    SELECT u.* FROM chat_room_members m
    JOIN users u ON u.id = m.userId
    WHERE m.roomId = ?
    ORDER BY u.login
  `),
  // Для честных счётчиков "фото/видео/файлы/ссылки" в модалке "Информация
  // о группе" — категоризация по расширению/наличию URL делается в JS
  // (см. roomMediaCounts()), не в SQL, чтобы не городить длинную CASE-цепочку.
  listRoomAttachmentsAndText: db.prepare("SELECT text, fileUrl FROM messages WHERE room = ?"),
  touchLastSeen: db.prepare("UPDATE users SET lastSeenAt = ? WHERE id = ?"),

  insertChatReport: db.prepare("INSERT INTO chat_reports (id, room, reporterId, note, createdAt) VALUES (?, ?, ?, ?, ?)"),
  listChatReports: db.prepare("SELECT * FROM chat_reports ORDER BY createdAt DESC"),
  deleteChatReport: db.prepare("DELETE FROM chat_reports WHERE id = ?"),

  // Поиск людей: раньше был SQL LIKE по login/displayName прямо здесь, но
  // встроенный LIKE в SQLite регистронезависим только для ASCII — "Иван"
  // не находился по запросу "иван" (кириллица не участвует в его
  // case-folding). Фильтрация по логину/имени переехала в JS (см.
  // /api/users), где обычный .toLowerCase() схлопывает кириллицу
  // корректно; этот стейтмент отдаёт всех, кроме себя, а сравнение — уже
  // в обработчике роута.
  listUsersExceptSelf: db.prepare("SELECT * FROM users WHERE id <> ?"),

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

  insertGroup: db.prepare("INSERT INTO groups (id, name, description, avatarUrl, ownerId, createdAt, category) VALUES (?, ?, ?, ?, ?, ?, ?)"),
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

  insertTrack: db.prepare("INSERT INTO tracks (id, ownerId, title, artist, filename, originalName, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)"),
  listTracksByOwner: db.prepare("SELECT * FROM tracks WHERE ownerId = ? ORDER BY createdAt DESC"),
  findTrackById: db.prepare("SELECT * FROM tracks WHERE id = ?"),
  deleteTrack: db.prepare("DELETE FROM tracks WHERE id = ?"),

  insertVideo: db.prepare("INSERT INTO videos (id, ownerId, title, kind, filename, originalName, externalUrl, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  listVideosByOwner: db.prepare("SELECT * FROM videos WHERE ownerId = ? ORDER BY createdAt DESC"),
  findVideoById: db.prepare("SELECT * FROM videos WHERE id = ?"),
  deleteVideo: db.prepare("DELETE FROM videos WHERE id = ?"),

  insertBook: db.prepare("INSERT INTO books (id, ownerId, title, author, coverUrl, status, link, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"),
  listBooksByOwner: db.prepare("SELECT * FROM books WHERE ownerId = ? ORDER BY createdAt DESC"),
  findBookById: db.prepare("SELECT * FROM books WHERE id = ?"),
  updateBook: db.prepare("UPDATE books SET title = ?, author = ?, coverUrl = ?, status = ?, link = ? WHERE id = ?"),
  deleteBook: db.prepare("DELETE FROM books WHERE id = ?"),

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
  `),

  // ===== Пользовательское соглашение (редактируется из админки) =====
  listTerms: db.prepare("SELECT * FROM terms_content"),
  getTermsByLang: db.prepare("SELECT * FROM terms_content WHERE lang = ?"),
  upsertTerms: db.prepare(`
    INSERT INTO terms_content (lang, label, title, body, updatedAt)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(lang) DO UPDATE SET title = excluded.title, body = excluded.body, updatedAt = excluded.updatedAt
  `),
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

// Дефолтный текст пользовательского соглашения (4 языка) — используется
// ТОЛЬКО как разовый посев в terms_content при пустой таблице (первый
// запуск сервера или свежая БД). После этого единственный источник
// правды — сама таблица, редактируется через PATCH /api/admin/terms/:lang
// (admin.html). "body" — один параграф на строку, тот же формат, что и в
// <textarea> редактора в админке.
const DEFAULT_TERMS = {
  ru: {
    label: "RU",
    title: "Пользовательское соглашение LÖMO",
    body: [
      "1. LÖMO — некоммерческий, экспериментальный проект одного разработчика (pet-проект), не связан с крупными компаниями и работает «как есть».",
      "2. Аккаунт. Логин и пароль вы придумываете сами; администрация не хранит и не может восстановить забытый пароль (почта или телефон к аккаунту не привязываются) — ответственность за сохранность данных для входа лежит на вас.",
      "3. Ваш контент. Публикуя посты, комментарии, фото, музыку, видео и другой контент, вы подтверждаете, что имеете на это право, и разрешаете показывать его другим пользователям сети в рамках обычной работы сервиса (лента, стена, чат и т.п.). Права на сам контент остаются за вами.",
      "4. Что запрещено. Оскорбления, разжигание ненависти и вражды по любому признаку, угрозы, спам, реклама без разрешения, загрузка чужого контента без прав, попытки взлома или эксплуатации уязвимостей.",
      "5. Модерация. Часть текста и изображений проверяется автоматическим фильтром; публикации, нарушающие правила, могут быть скрыты или удалены, а аккаунт — заблокирован администрацией без предварительного уведомления.",
      "6. Данные. Вся информация хранится в базе данных проекта на сервере; она не продаётся и не передаётся третьим лицам. Администраторы технически имеют доступ к содержимому в целях модерации.",
      "7. Отказ от гарантий. Сервис — некоммерческий эксперимент, предоставляется «как есть», без гарантий бесперебойной работы; данные могут быть утеряны при технических сбоях или перезапуске сервера — делайте резервные копии важного вам содержимого самостоятельно, если это критично.",
      "8. Возраст. Сервисом не рекомендуется пользоваться лицам младше 13 лет.",
      "9. Изменения. Это соглашение может быть изменено; продолжая пользоваться LÖMO после изменений, вы соглашаетесь с новой версией.",
      "10. Согласие. Регистрируясь, вы подтверждаете, что прочитали и принимаете условия этого соглашения.",
    ].join("\n"),
  },
  uk: {
    label: "UA",
    title: "Угода користувача LÖMO",
    body: [
      "1. LÖMO — некомерційний, експериментальний проєкт одного розробника (pet-проєкт), не пов'язаний із великими компаніями і працює «як є».",
      "2. Обліковий запис. Логін і пароль ви вигадуєте самостійно; адміністрація не зберігає і не може відновити забутий пароль (пошта чи телефон до акаунта не прив'язуються) — відповідальність за збереження даних для входу лежить на вас.",
      "3. Ваш контент. Публікуючи пости, коментарі, фото, музику, відео та інший контент, ви підтверджуєте, що маєте на це право, і дозволяєте показувати його іншим користувачам мережі в межах звичайної роботи сервісу (стрічка, стіна, чат тощо). Права на сам контент залишаються за вами.",
      "4. Що заборонено. Образи, розпалювання ненависті та ворожнечі за будь-якою ознакою, погрози, спам, реклама без дозволу, завантаження чужого контенту без прав, спроби зламу або експлуатації вразливостей.",
      "5. Модерація. Частина тексту та зображень перевіряється автоматичним фільтром; публікації, що порушують правила, можуть бути приховані або видалені, а обліковий запис — заблокований адміністрацією без попереднього повідомлення.",
      "6. Дані. Уся інформація зберігається в базі даних проєкту на сервері; вона не продається і не передається третім особам. Адміністратори технічно мають доступ до вмісту з метою модерації.",
      "7. Відмова від гарантій. Сервіс є некомерційним експериментом, надається «як є», без гарантій безперебійної роботи; дані можуть бути втрачені через технічні збої або перезапуск сервера — робіть резервні копії важливого вам вмісту самостійно, якщо це критично.",
      "8. Вік. Сервісом не рекомендується користуватися особам молодше 13 років.",
      "9. Зміни. Ця угода може бути змінена; продовжуючи користуватися LÖMO після змін, ви погоджуєтесь із новою версією.",
      "10. Згода. Реєструючись, ви підтверджуєте, що прочитали і приймаєте умови цієї угоди.",
    ].join("\n"),
  },
  en: {
    label: "EN",
    title: "LÖMO Terms of Service",
    body: [
      "1. LÖMO is a non-commercial, experimental one-developer pet project, not affiliated with any large company, and is provided “as is”.",
      "2. Your account. You choose your own login and password; the administration does not store and cannot recover a forgotten password (no email or phone is linked to the account) — you are responsible for keeping your login credentials safe.",
      "3. Your content. By posting posts, comments, photos, music, videos and other content, you confirm you have the right to do so, and you allow it to be shown to other users as part of the normal operation of the service (feed, wall, chat, etc.). You keep the rights to your own content.",
      "4. Prohibited. Insults, incitement of hatred or hostility on any ground, threats, spam, unauthorized advertising, uploading someone else's content without rights, attempts to hack or exploit vulnerabilities.",
      "5. Moderation. Some text and images are checked by an automated filter; publications that violate the rules may be hidden or removed, and the account may be banned by the administration without prior notice.",
      "6. Data. All information is stored in the project's database on the server; it is not sold or shared with third parties. Administrators technically have access to content for moderation purposes.",
      "7. Disclaimer. The service is a non-commercial experiment provided “as is”, with no guarantee of uninterrupted operation; data may be lost due to technical failures or server restarts — back up anything important to you yourself if it matters.",
      "8. Age. The service is not recommended for people under 13 years old.",
      "9. Changes. This agreement may change; by continuing to use LÖMO after changes, you agree to the new version.",
      "10. Consent. By registering, you confirm that you have read and accept the terms of this agreement.",
    ].join("\n"),
  },
  es: {
    label: "ES",
    title: "Acuerdo de usuario de LÖMO",
    body: [
      "1. LÖMO es un proyecto experimental, no comercial, de un solo desarrollador (proyecto personal), sin relación con ninguna gran empresa, y se ofrece «tal cual».",
      "2. Tu cuenta. Eliges tu propio nombre de usuario y contraseña; la administración no almacena ni puede recuperar una contraseña olvidada (no hay correo ni teléfono vinculado a la cuenta) — eres responsable de mantener seguros tus datos de acceso.",
      "3. Tu contenido. Al publicar publicaciones, comentarios, fotos, música, vídeos y otro contenido, confirmas que tienes derecho a hacerlo y permites que se muestre a otros usuarios como parte del funcionamiento normal del servicio (feed, muro, chat, etc.). Conservas los derechos sobre tu propio contenido.",
      "4. Prohibido. Insultos, incitación al odio o a la hostilidad por cualquier motivo, amenazas, spam, publicidad no autorizada, subir contenido ajeno sin derechos, intentos de hackear o explotar vulnerabilidades.",
      "5. Moderación. Parte del texto y las imágenes se revisan mediante un filtro automático; las publicaciones que infrinjan las normas pueden ocultarse o eliminarse, y la cuenta puede ser bloqueada por la administración sin previo aviso.",
      "6. Datos. Toda la información se almacena en la base de datos del proyecto en el servidor; no se vende ni se comparte con terceros. Los administradores tienen acceso técnico al contenido con fines de moderación.",
      "7. Exención de garantías. El servicio es un experimento no comercial ofrecido «tal cual», sin garantía de funcionamiento ininterrumpido; los datos pueden perderse por fallos técnicos o reinicios del servidor — haz tus propias copias de seguridad de lo que sea importante para ti.",
      "8. Edad. No se recomienda el uso del servicio a personas menores de 13 años.",
      "9. Cambios. Este acuerdo puede modificarse; si continúas usando LÖMO después de los cambios, aceptas la nueva versión.",
      "10. Consentimiento. Al registrarte, confirmas que has leído y aceptas los términos de este acuerdo.",
    ].join("\n"),
  },
};

(function seedDefaultTerms() {
  if (stmts.listTerms.all().length > 0) return;
  const now = Date.now();
  for (const [lang, data] of Object.entries(DEFAULT_TERMS)) {
    stmts.upsertTerms.run(lang, data.label, data.title, data.body, now);
  }
  console.log("📄 Пользовательское соглашение засеяно дефолтным текстом на 4 языках.");
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

// Общий поиск по людям — логин ИЛИ отображаемое имя (значит имя+фамилия,
// см. displayName при регистрации) ИЛИ точный ID, регистронезависимо для
// ЛЮБОГО алфавита. Сравнение через JS .toLowerCase(), а не SQL LIKE —
// LIKE в SQLite регистронезависим только для ASCII, кириллица (и вообще
// всё не-ASCII) им не схлопывается ("Иван" не находился по "иван").
// Используется и в /api/users (поиск для друзей/личных диалогов), и в
// /api/admin/users (поиск в админке) — раньше там была разная, отдельно
// поддерживаемая логика с разным набором полей.
function matchesUserQuery(user, query) {
  const q = query.toLowerCase();
  return (
    user.id === query ||
    user.login.toLowerCase().includes(q) ||
    (user.displayName || "").toLowerCase().includes(q)
  );
}

// Честные счётчики "фото/видео/файлы/ссылки" для модалки "Информация о
// группе" — категоризация вложений по расширению файла и поиск ссылок
// простым regex по тексту сообщения. Не отдельная СУЩНОСТЬ (галерея с
// превью), просто числа — так и договорились с пользователем: без
// отдельной выдачи файлов постранично это сильно проще и всё ещё честно.
const MEDIA_IMAGE_EXT = new Set(["jpg", "jpeg", "png", "gif", "webp", "svg", "avif"]);
const MEDIA_VIDEO_EXT = new Set(["mp4", "webm", "mov", "ogg", "mkv"]);
const MEDIA_URL_RE = /https?:\/\/\S+/i;

// Достаёт ID видео из обычных форматов ссылок YouTube (watch?v=, youtu.be/,
// shorts/, embed/) — нужен, чтобы честно встроить плеер (iframe embed),
// а не просто выводить кликабельную ссылку. Для всего, что не YouTube,
// возвращает null — клиент в этом случае просто показывает ссылку
// "Открыть" вместо плеера (никаких сторонних embed-провайдеров не
// парсим, это уже отдельная, гораздо большая задача).
function parseYouTubeId(url) {
  if (!url || typeof url !== "string") return null;
  const patterns = [
    /(?:youtube\.com\/watch\?v=)([\w-]{11})/,
    /(?:youtu\.be\/)([\w-]{11})/,
    /(?:youtube\.com\/shorts\/)([\w-]{11})/,
    /(?:youtube\.com\/embed\/)([\w-]{11})/
  ];
  for (const re of patterns) {
    const m = url.match(re);
    if (m) return m[1];
  }
  return null;
}

function extensionOf(url) {
  const match = /\.([a-z0-9]+)(?:\?.*)?$/i.exec(url || "");
  return match ? match[1].toLowerCase() : "";
}

function roomMediaCounts(roomId) {
  const rows = stmts.listRoomAttachmentsAndText.all(roomId);
  const counts = { photos: 0, videos: 0, files: 0, links: 0 };
  for (const row of rows) {
    if (row.fileUrl) {
      const ext = extensionOf(row.fileUrl);
      if (MEDIA_IMAGE_EXT.has(ext)) counts.photos++;
      else if (MEDIA_VIDEO_EXT.has(ext)) counts.videos++;
      else counts.files++;
    }
    if (row.text && MEDIA_URL_RE.test(row.text)) counts.links++;
  }
  return counts;
}

function toPublicUser(user) {
  return {
    id: user.id,
    login: user.login,
    displayName: user.displayName || "",
    avatarUrl: user.avatarUrl,
    about: user.about || "",
    birthDate: user.birthDate || "",
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
    category: group.category || DEFAULT_GROUP_CATEGORY,
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
  const { login, password, avatarUrl, agreedToTerms, website, firstName, lastName, birthDate } = req.body;
  try {
    // Honeypot — поле "website" на клиенте (auth.html) уведено за пределы
    // экрана и невидимо человеку; заполняет его только бот, слепо
    // проходящий по всем полям формы. Отвечаем той же формой ошибки, что и
    // остальная валидация, — не подсказываем боту, что именно его спалило.
    if (website) return res.status(400).json({ error: "Не удалось выполнить регистрацию" });
    if (!login || !password) return res.status(400).json({ error: "Укажи логин и пароль" });
    if (!LOGIN_FORMAT_RE.test(login)) {
      return res.status(400).json({ error: "Логин: 3–32 символа, латиница, цифры, точка или подчёркивание, без пробелов" });
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return res.status(400).json({ error: `Пароль минимум ${MIN_PASSWORD_LENGTH} символов` });
    }
    const first = typeof firstName === "string" ? firstName.trim() : "";
    const last  = typeof lastName === "string" ? lastName.trim() : "";
    if (!NAME_FORMAT_RE.test(first) || !NAME_FORMAT_RE.test(last)) {
      return res.status(400).json({ error: "Укажи имя и фамилию (только буквы, дефис или апостроф)" });
    }
    if (typeof birthDate !== "string" || !BIRTH_DATE_RE.test(birthDate) || isNaN(new Date(birthDate).getTime())) {
      return res.status(400).json({ error: "Укажи корректную дату рождения" });
    }
    if (new Date(birthDate).getTime() > Date.now()) {
      return res.status(400).json({ error: "Дата рождения не может быть в будущем" });
    }
    const age = calculateAge(birthDate);
    if (age < MIN_REGISTRATION_AGE) {
      return res.status(400).json({ error: `LÖMO не для тех, кому меньше ${MIN_REGISTRATION_AGE} лет` });
    }
    if (age > 120) {
      return res.status(400).json({ error: "Проверь дату рождения — похоже на опечатку" });
    }
    if (!agreedToTerms) {
      return res.status(400).json({ error: "Нужно принять пользовательское соглашение" });
    }
    const existing = stmts.findUserByLogin.get(login);
    if (existing) return res.status(400).json({ error: "Логин занят" });
    const user = {
      id: generateUserId(), login, password: hashPassword(password), avatarUrl: avatarUrl || "",
      isAdmin: 0, createdAt: Date.now(), termsAcceptedAt: Date.now(), displayName: `${first} ${last}`, birthDate
    };
    stmts.insertUser.run(user.id, user.login, user.password, user.avatarUrl, user.createdAt, user.termsAcceptedAt, user.displayName, user.birthDate);
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

// Пользовательское соглашение — публичный роут (без requireAuth), т.к.
// модалка на auth.html открывается ДО входа, во время регистрации.
// Редактирование — только через PATCH /api/admin/terms/:lang (см. ниже,
// секция "Админка").
app.get("/api/terms", (req, res) => {
  try {
    const rows = stmts.listTerms.all();
    const result = {};
    for (const row of rows) {
      result[row.lang] = { label: row.label, title: row.title, body: row.body };
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: "Не удалось загрузить соглашение" }); }
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
    const rows = stmts.listUsersExceptSelf.all(req.user.id)
      .filter((u) => matchesUserQuery(u, q))
      .sort((a, b) => a.login.localeCompare(b.login))
      .slice(0, 20);
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
    const category = GROUP_CATEGORY_KEYS.has(req.body.category) ? req.body.category : DEFAULT_GROUP_CATEGORY;
    const id = crypto.randomUUID();
    const now = Date.now();
    stmts.insertGroup.run(id, name, description, avatarUrl, req.user.id, now, category);
    stmts.insertMember.run(id, req.user.id, "owner", now);
    res.json(toGroupPayload(stmts.findGroupById.get(id)));
  } catch (e) { res.status(500).json({ error: "Ошибка создания группы" }); }
});

// Поиск/фильтрация — по совету дизайн-ревью (см. CLAUDE.md): текстовый
// поиск по названию/описанию (регистронезависимо для любого алфавита,
// сравнение в JS — та же причина, что и у поиска людей: SQL LIKE в SQLite
// не схлопывает кириллицу), фильтр по категории, вкладка "мои группы"
// (состою ИЛИ владею), сортировка по популярности (число участников,
// дефолт) или по дате создания. На масштабе этого проекта (не тысячи
// групп) вытащить все и отфильтровать/отсортировать в JS — не проблема
// производительности.
app.get("/api/groups", requireAuth, (req, res) => {
  try {
    const q = (req.query.q || "").trim().toLowerCase();
    const category = req.query.category || "";
    const mine = req.query.mine === "1" || req.query.mine === "true";
    const sort = req.query.sort === "new" ? "new" : "popular";

    let rows = stmts.listGroups.all().map(toGroupPayload);

    if (mine) {
      rows = rows.filter((g) => g.ownerId === req.user.id || stmts.findMember.get(g.id, req.user.id));
    }
    if (category && category !== "all") {
      rows = rows.filter((g) => g.category === category);
    }
    if (q) {
      rows = rows.filter((g) =>
        g.name.toLowerCase().includes(q) || (g.description || "").toLowerCase().includes(q)
      );
    }
    rows.sort(sort === "new"
      ? (a, b) => b.createdAt - a.createdAt
      : (a, b) => b.membersCount - a.membersCount || b.createdAt - a.createdAt);

    res.json(rows);
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

// ===== Музыка — реальные загруженные файлы, честный список своих треков =====

function toTrackPayload(t) {
  return { id: t.id, ownerId: t.ownerId, title: t.title, artist: t.artist, createdAt: t.createdAt, url: `/uploads/${t.filename}` };
}

app.post("/api/tracks", requireAuth, uploadAudio.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Нужен аудиофайл" });
    const originalName = fixFilenameEncoding(req.file.originalname);
    const title = (req.body.title || "").trim() || originalName.replace(/\.[^.]+$/, "");
    const artist = (req.body.artist || "").trim();
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    stmts.insertTrack.run(id, req.user.id, title, artist, req.file.filename, originalName, createdAt);
    res.json(toTrackPayload({ id, ownerId: req.user.id, title, artist, filename: req.file.filename, createdAt }));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки трека" }); }
});

app.get("/api/tracks", requireAuth, (req, res) => {
  try {
    res.json(stmts.listTracksByOwner.all(req.user.id).map(toTrackPayload));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки музыки" }); }
});

app.delete("/api/tracks/:id", requireAuth, (req, res) => {
  try {
    const track = stmts.findTrackById.get(req.params.id);
    if (!track) return res.status(404).json({ error: "Трек не найден" });
    if (track.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Это не ваш трек" });
    fs.unlink(path.join(UPLOADS_DIR, track.filename), () => {});
    stmts.deleteTrack.run(track.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления трека" }); }
});

// ===== Видео — свой загруженный файл ИЛИ внешняя ссылка (YouTube embed,
// остальное — просто кликабельная ссылка на клиенте) =====

function toVideoPayload(v) {
  const out = { id: v.id, ownerId: v.ownerId, title: v.title, kind: v.kind, createdAt: v.createdAt };
  if (v.kind === "upload") {
    out.url = `/uploads/${v.filename}`;
  } else {
    out.externalUrl = v.externalUrl;
    out.youtubeId = parseYouTubeId(v.externalUrl);
  }
  return out;
}

app.post("/api/videos/upload", requireAuth, uploadVideo.single("file"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Нужен видеофайл" });
    const originalName = fixFilenameEncoding(req.file.originalname);
    const title = (req.body.title || "").trim() || originalName.replace(/\.[^.]+$/, "");
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    stmts.insertVideo.run(id, req.user.id, title, "upload", req.file.filename, originalName, null, createdAt);
    res.json(toVideoPayload({ id, ownerId: req.user.id, title, kind: "upload", filename: req.file.filename, createdAt }));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки видео" }); }
});

app.post("/api/videos/link", requireAuth, (req, res) => {
  try {
    const externalUrl = (req.body.externalUrl || "").trim();
    if (!externalUrl) return res.status(400).json({ error: "Нужна ссылка" });
    if (!/^https?:\/\//i.test(externalUrl)) return res.status(400).json({ error: "Ссылка должна начинаться с http(s)://" });
    const title = (req.body.title || "").trim() || externalUrl;
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    stmts.insertVideo.run(id, req.user.id, title, "link", null, null, externalUrl, createdAt);
    res.json(toVideoPayload({ id, ownerId: req.user.id, title, kind: "link", externalUrl, createdAt }));
  } catch (e) { res.status(500).json({ error: "Ошибка добавления ссылки" }); }
});

app.get("/api/videos", requireAuth, (req, res) => {
  try {
    res.json(stmts.listVideosByOwner.all(req.user.id).map(toVideoPayload));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки видео" }); }
});

app.delete("/api/videos/:id", requireAuth, (req, res) => {
  try {
    const video = stmts.findVideoById.get(req.params.id);
    if (!video) return res.status(404).json({ error: "Видео не найдено" });
    if (video.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Это не ваше видео" });
    if (video.kind === "upload") fs.unlink(path.join(UPLOADS_DIR, video.filename), () => {});
    stmts.deleteVideo.run(video.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления видео" }); }
});

// ===== Книги — личная библиотека для чтения (карточки, не файлы) =====

const BOOK_STATUSES = new Set(["want", "reading", "done"]);

app.post("/api/books", requireAuth, (req, res) => {
  try {
    const title = (req.body.title || "").trim();
    if (!title) return res.status(400).json({ error: "Нужно название" });
    const author = (req.body.author || "").trim();
    const coverUrl = (req.body.coverUrl || "").trim();
    const link = (req.body.link || "").trim();
    const status = BOOK_STATUSES.has(req.body.status) ? req.body.status : "want";
    const id = crypto.randomUUID();
    const createdAt = Date.now();
    stmts.insertBook.run(id, req.user.id, title, author, coverUrl, status, link, createdAt);
    res.json(stmts.findBookById.get(id));
  } catch (e) { res.status(500).json({ error: "Ошибка добавления книги" }); }
});

app.get("/api/books", requireAuth, (req, res) => {
  try {
    res.json(stmts.listBooksByOwner.all(req.user.id));
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки книг" }); }
});

app.patch("/api/books/:id", requireAuth, (req, res) => {
  try {
    const book = stmts.findBookById.get(req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    if (book.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Это не ваша книга" });
    const title = typeof req.body.title === "string" && req.body.title.trim() ? req.body.title.trim() : book.title;
    const author = typeof req.body.author === "string" ? req.body.author.trim() : book.author;
    const coverUrl = typeof req.body.coverUrl === "string" ? req.body.coverUrl.trim() : book.coverUrl;
    const link = typeof req.body.link === "string" ? req.body.link.trim() : book.link;
    const status = BOOK_STATUSES.has(req.body.status) ? req.body.status : book.status;
    stmts.updateBook.run(title, author, coverUrl, status, link, book.id);
    res.json(stmts.findBookById.get(book.id));
  } catch (e) { res.status(500).json({ error: "Ошибка обновления книги" }); }
});

app.delete("/api/books/:id", requireAuth, (req, res) => {
  try {
    const book = stmts.findBookById.get(req.params.id);
    if (!book) return res.status(404).json({ error: "Книга не найдена" });
    if (book.ownerId !== req.user.id && !req.user.isAdmin) return res.status(403).json({ error: "Это не ваша книга" });
    stmts.deleteBook.run(book.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка удаления книги" }); }
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
    let rows = stmts.listAllUsers.all();
    // Раньше искало только по логину — не находило по имени/фамилии
    // (displayName), хотя именно их видно в самой таблице админки.
    if (q) rows = rows.filter((u) => matchesUserQuery(u, q));
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

// Данные для модалки "Информация о группе" (по клику на название чата) —
// карточка комнаты (если зарегистрирована — "public" и подобные честно
// идут без owner/createdAt), настоящий список участников (chat_room_members,
// не выдуманное число) и честные счётчики медиа по истории сообщений.
// Не для DM — у личного диалога своя "визитка" (openChatPeerCard в app.js).
app.get("/api/chat-rooms/:id/members", requireAuth, (req, res) => {
  try {
    const roomId = req.params.id;
    if (roomId.startsWith("dm-")) return res.status(400).json({ error: "Не применимо к личным диалогам" });
    const room = stmts.findChatRoom.get(roomId);
    const owner = room ? stmts.findUserById.get(room.ownerId) : null;

    const onlineLogins = new Set();
    clients.forEach((c) => { if (c.ws.readyState === 1) onlineLogins.add(c.login); });

    const members = stmts.listRoomMembers.all(roomId).map((u) => ({
      id: u.id,
      displayName: displayNameOf(u),
      avatarUrl: u.avatarUrl,
      online: onlineLogins.has(u.login),
      lastSeenAt: u.lastSeenAt || null
    }));

    res.json({
      id: roomId,
      name: (room && room.name) || (roomId === "public" ? "Общий чат" : roomId),
      avatarUrl: room ? room.avatarUrl : "",
      ownerId: room ? room.ownerId : null,
      ownerName: owner ? displayNameOf(owner) : null,
      createdAt: room ? room.createdAt : null,
      members,
      counts: roomMediaCounts(roomId)
    });
  } catch (e) { res.status(500).json({ error: "Ошибка загрузки информации о группе" }); }
});

// "Покинуть" из новой модалки — убирает только членство (см. выше), сама
// комната/её сообщения никуда не деваются, и владелец не теряет права
// (в отличие от групп в groups.html, тут нет отдельной роли владельца
// членства — только у ownerId в chat_rooms, "Управление" им и так защищено).
app.post("/api/chat-rooms/:id/leave", requireAuth, (req, res) => {
  try {
    stmts.deleteRoomMember.run(req.params.id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: "Ошибка выхода из комнаты" }); }
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

// Редактирование пользовательского соглашения — только заголовок и текст,
// сам язык (:lang) и его подпись (label — "RU"/"UA"/"EN"/"ES") фиксированы
// набором строк в DEFAULT_TERMS/terms_content, новый язык через этот роут
// не завести (это уже фронтенд-задача — понадобится ещё вкладка в
// admin.html и в модалке на auth.html).
app.patch("/api/admin/terms/:lang", requireAuth, requireAdmin, (req, res) => {
  try {
    const { lang } = req.params;
    const existing = stmts.getTermsByLang.get(lang);
    if (!existing) return res.status(404).json({ error: "Неизвестный язык" });
    const title = typeof req.body.title === "string" ? req.body.title.trim() : "";
    const body  = typeof req.body.body === "string" ? req.body.body.trim() : "";
    if (!title || !body) return res.status(400).json({ error: "Заголовок и текст соглашения не должны быть пустыми" });
    stmts.upsertTerms.run(lang, existing.label, title, body, Date.now());
    res.json({ lang, label: existing.label, title, body });
  } catch (e) { res.status(500).json({ error: "Ошибка сохранения соглашения" }); }
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
// дублей — если у кого-то открыто две вкладки, считается один раз) — честный
// live-счётчик "кто прямо сейчас смотрит в этот чат", показываем в шапке.
// Не путать с ЧЛЕНСТВОМ (chat_room_members, ниже) — членство это "кто хоть
// раз открывал эту комнату", постоянный список для модалки "Информация о
// группе"; presence — только "кто в ней прямо сейчас", ничего не хранит.
function broadcastPresence(room) {
  const logins = new Set();
  clients.forEach((c) => { if (c.room === room && c.ws.readyState === 1) logins.add(c.login); });
  const payload = JSON.stringify({ type: "presence", room, count: logins.size });
  clients.forEach((c) => { if (c.room === room && c.ws.readyState === 1) c.ws.send(payload); });
}

// Статус собеседника в личном диалоге (шапка chats.html для dm-<a>-<b>) —
// три состояния вместо "N в сети" (это осмысленно для комнаты с кучей
// народу, но не для диалога один на один): "reading" — собеседник прямо
// сейчас держит открытым ИМЕННО этот диалог, "online" — подключён где-то
// ещё (другая страница/комната), но не сюда, "offline" — нигде не
// подключён. dm-<a>-<b> кодирует ID участников прямо в имени комнаты —
// не нужна отдельная таблица, просто разбираем строку.
function getDmParticipantIds(roomId) {
  if (!roomId.startsWith("dm-")) return null;
  const parts = roomId.slice(3).split("-");
  return parts.length === 2 ? parts : null;
}

function dmConnectionState(userId, roomId) {
  const user = stmts.findUserById.get(userId);
  if (!user) return "offline";
  let here = false, elsewhere = false;
  clients.forEach((c) => {
    if (c.ws.readyState !== 1 || c.login !== user.login) return;
    if (c.room === roomId) here = true; else elsewhere = true;
  });
  if (here) return "reading";
  if (elsewhere) return "online";
  return "offline";
}

// Пересчитывает и рассылает статус КАЖДОМУ участнику диалога — то, что он
// видит, это статус СОБЕСЕДНИКА, не свой собственный. Дёргается на любое
// подключение/отключение (см. ниже) сразу для всех сейчас активных
// dm-комнат — при масштабе этого проекта (десятки, не тысячи
// одновременных соединений) пересчёт "в лоб" по всем активным диалогам
// дешевле, чем городить точечную инвалидацию по паре участников.
function broadcastDmPeerStatuses() {
  const activeDmRooms = new Set();
  clients.forEach((c) => { if (c.room.startsWith("dm-") && c.ws.readyState === 1) activeDmRooms.add(c.room); });
  activeDmRooms.forEach((roomId) => {
    const ids = getDmParticipantIds(roomId);
    if (!ids) return;
    const [idA, idB] = ids;
    const userA = stmts.findUserById.get(idA);
    const userB = stmts.findUserById.get(idB);
    const statusForA = dmConnectionState(idB, roomId); // то, что видит A о B
    const statusForB = dmConnectionState(idA, roomId); // то, что видит B о A
    clients.forEach((c) => {
      if (c.room !== roomId || c.ws.readyState !== 1) return;
      if (userA && c.login === userA.login) {
        c.ws.send(JSON.stringify({ type: "peerStatus", room: roomId, status: statusForA }));
      } else if (userB && c.login === userB.login) {
        c.ws.send(JSON.stringify({ type: "peerStatus", room: roomId, status: statusForB }));
      }
    });
  });
}

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `https://${req.headers.host}`);
  let currentRoom = url.searchParams.get("room") || "public";

  // Раньше сервер верил query-параметру login на слово — любой, кто знал
  // чужой login (публичный, виден в поиске/ссылках), мог подключиться к
  // WS и слать сообщения от чужого имени (известная проблема #3 в
  // CLAUDE.md). Теперь identity берётся ТОЛЬКО из подписанного JWT
  // (тот же token, что уже хранится в localStorage и шлётся в
  // Authorization для REST) — если токена нет, он просрочен или подделан,
  // соединение сразу закрывается. Query-параметр login клиент больше не
  // присылает вообще (см. connectWebSocket() в app.js).
  const token = url.searchParams.get("token");
  let payload;
  try {
    payload = token && jwt.verify(token, JWT_SECRET);
  } catch (e) {
    payload = null;
  }
  if (!payload || !payload.login) {
    ws.close(4001, "unauthorized");
    return;
  }
  const login = payload.login;

  // Бан проверяем по актуальному состоянию БД (не по тому, что было
  // зашито в токен при выдаче) — тот же принцип, что и у requireAuth.
  const connectingUser = stmts.findUserByLogin.get(login);
  if (!connectingUser) {
    ws.close(4004, "user not found");
    return;
  }
  if (connectingUser.isBanned) {
    ws.close(4003, "banned");
    return;
  }

  const client = { ws, login, room: currentRoom };
  clients.add(client);
  broadcastPresence(currentRoom);
  broadcastDmPeerStatuses();

  // Членство — только для настоящих комнат/групп, не для личных диалогов
  // (у dm-<a>-<b> ровно два известных участника и без этой таблицы).
  // INSERT OR IGNORE — заводится один раз, повторные подключения того же
  // человека к той же комнате ничего не меняют (joinedAt — момент первого
  // захода, не последнего).
  if (connectingUser && !currentRoom.startsWith("dm-")) {
    stmts.insertRoomMember.run(currentRoom, connectingUser.id, Date.now());
  }
  if (connectingUser) stmts.touchLastSeen.run(Date.now(), connectingUser.id);

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

      // "Печатает..." — чисто эфемерный сигнал, ничего не сохраняем и не
      // проверяем на будущее: просто пересылаем всем ОСТАЛЬНЫМ в этой же
      // комнате (на практике — второму участнику диалога; клиент сам
      // решает показывать индикатор только для dm-комнат). Троттлинг —
      // на клиенте (не шлём чаще раза в ~2с), здесь его нет намеренно.
      if (msg.type === "typing") {
        clients.forEach((c) => {
          if (c.room === currentRoom && c.login !== client.login && c.ws.readyState === 1) {
            c.ws.send(JSON.stringify({ type: "typing", room: currentRoom }));
          }
        });
        return;
      }
    } catch (e) { console.error(e); }
  });

  ws.on("close", () => {
    clients.delete(client);
    broadcastPresence(currentRoom);
    broadcastDmPeerStatuses();
    if (connectingUser) stmts.touchLastSeen.run(Date.now(), connectingUser.id);
  });
});

server.listen(PORT, () => console.log(`Server started on port ${PORT}`));
