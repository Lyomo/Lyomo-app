import { DatabaseSync } from "node:sqlite";
import fs from "fs";
import path from "path";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "lomo.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec("PRAGMA journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    login TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatarUrl TEXT NOT NULL DEFAULT '',
    isAdmin INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL DEFAULT 'public',
    fromLogin TEXT NOT NULL,
    text TEXT NOT NULL,
    avatar TEXT NOT NULL DEFAULT '',
    ts INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages (room, ts);

  CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    ownerType TEXT NOT NULL CHECK(ownerType IN ('user','group')),
    ownerId TEXT NOT NULL,
    authorId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_posts_owner ON posts (ownerType, ownerId, createdAt);

  CREATE TABLE IF NOT EXISTS likes (
    postId TEXT NOT NULL,
    userId TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (postId, userId)
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    postId TEXT NOT NULL,
    authorId TEXT NOT NULL,
    text TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_comments_post ON comments (postId, createdAt);

  CREATE TABLE IF NOT EXISTS friendships (
    id TEXT PRIMARY KEY,
    userA TEXT NOT NULL,
    userB TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','accepted')),
    requestedBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    CHECK(userA <> userB),
    UNIQUE(userA, userB)
  );
  CREATE INDEX IF NOT EXISTS idx_friendships_a ON friendships (userA);
  CREATE INDEX IF NOT EXISTS idx_friendships_b ON friendships (userB);

  CREATE TABLE IF NOT EXISTS groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    avatarUrl TEXT NOT NULL DEFAULT '',
    ownerId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS group_members (
    groupId TEXT NOT NULL,
    userId TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'member',
    joinedAt INTEGER NOT NULL,
    PRIMARY KEY (groupId, userId)
  );

  CREATE TABLE IF NOT EXISTS albums (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    title TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    albumId TEXT NOT NULL,
    ownerId TEXT NOT NULL,
    filename TEXT NOT NULL,
    originalName TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS stories (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    photoUrl TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_stories_owner_created ON stories (ownerId, createdAt);

  -- "Карточка" поверх комнаты чата (id которой — просто произвольная строка,
  -- к ней можно подключиться по WS ничего не регистрируя). Регистрируется
  -- опционально при создании комнаты через "+ Комната" — даёт настоящее имя/
  -- аватар/владельца для "Информация о группе"/"Управление группой" в меню
  -- чата. Комнаты без карточки (напр. "public") эти пункты меню не показывают.
  CREATE TABLE IF NOT EXISTS chat_rooms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    avatarUrl TEXT NOT NULL DEFAULT '',
    ownerId TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS chat_reports (
    id TEXT PRIMARY KEY,
    room TEXT NOT NULL,
    reporterId TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL
  );

  -- Настоящее членство в комнате чата (не DM — у личных диалогов ровно два
  -- известных участника и без отдельной таблицы, см. dm-<a>-<b>). Строка
  -- появляется, когда пользователь подключается по WS к этой комнате (см.
  -- wss.on("connection") в server.js) — то есть реально хоть раз открывал
  -- этот чат, а не "может теоретически подключиться, зная id". Используется
  -- модалкой "Информация о группе" для честного списка участников вместо
  -- выдуманных чисел.
  CREATE TABLE IF NOT EXISTS chat_room_members (
    roomId TEXT NOT NULL,
    userId TEXT NOT NULL,
    joinedAt INTEGER NOT NULL,
    PRIMARY KEY (roomId, userId)
  );
  CREATE INDEX IF NOT EXISTS idx_room_members_room ON chat_room_members (roomId);

  -- Музыка/Видео/Книги — раньше просто список строк в localStorage
  -- (заглушка), теперь настоящий личный контент с реальной загрузкой
  -- файлов через тот же /uploads, что у фото/чата.
  CREATE TABLE IF NOT EXISTS tracks (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    title TEXT NOT NULL,
    artist TEXT NOT NULL DEFAULT '',
    filename TEXT NOT NULL,
    originalName TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_owner ON tracks (ownerId, createdAt);

  -- kind='upload' — свой файл (filename/originalName заполнены), kind='link'
  -- — внешняя ссылка (сейчас честно умеем встраивать только YouTube,
  -- остальное — просто кликабельная ссылка "Открыть", см. parseYouTubeId()
  -- в server.js и рендер на клиенте).
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    title TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('upload','link')),
    filename TEXT,
    originalName TEXT,
    externalUrl TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_videos_owner ON videos (ownerId, createdAt);

  -- Личная библиотека для чтения — не файлы книг, а карточки (обложка
  -- ссылкой, как у аватара/группы — тот же осознанно простой паттерн),
  -- статус "хочу прочитать/читаю/прочитано" и опциональная ссылка "читать".
  CREATE TABLE IF NOT EXISTS books (
    id TEXT PRIMARY KEY,
    ownerId TEXT NOT NULL,
    title TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    coverUrl TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'want' CHECK(status IN ('want','reading','done')),
    link TEXT NOT NULL DEFAULT '',
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_books_owner ON books (ownerId, createdAt);

  -- Пользовательское соглашение — редактируется из админки (см.
  -- server.js: GET /api/terms — публичный, читает модалка на auth.html;
  -- PATCH /api/admin/terms/:lang — только админ). "body" - параграфы,
  -- по одному на строку (перевод строки как разделитель) - это же формат,
  -- в котором его показывает и редактирует textarea в admin.html, один
  -- к одному, без парсинга JSON туда-обратно. Заполняется дефолтным
  -- текстом на 4 языках при первом старте сервера, если таблица пустая
  -- (см. seedDefaultTerms() в server.js).
  CREATE TABLE IF NOT EXISTS terms_content (
    lang TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`);

// Безопасные аддитивные миграции для баз, созданных до появления этих колонок
// (ALTER TABLE ADD COLUMN ничего не удаляет и не трогает существующие строки).
function ensureColumn(table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
ensureColumn("posts", "photoUrl", "TEXT");
ensureColumn("messages", "fileUrl", "TEXT");
ensureColumn("messages", "fileName", "TEXT");
ensureColumn("users", "about", "TEXT NOT NULL DEFAULT ''");
ensureColumn("comments", "photoUrl", "TEXT");
ensureColumn("users", "displayName", "TEXT NOT NULL DEFAULT ''");
ensureColumn("messages", "fromDisplayName", "TEXT");
ensureColumn("users", "isBanned", "INTEGER NOT NULL DEFAULT 0");
ensureColumn("users", "createdAt", "INTEGER");
ensureColumn("posts", "moderationStatus", "TEXT NOT NULL DEFAULT 'clean'");
ensureColumn("posts", "moderationReason", "TEXT");
ensureColumn("comments", "moderationStatus", "TEXT NOT NULL DEFAULT 'clean'");
ensureColumn("comments", "moderationReason", "TEXT");
ensureColumn("messages", "pollData", "TEXT");
ensureColumn("messages", "checklistData", "TEXT");
// Момент последней активности (WS-подключение/отключение) — нужен для
// честного "был(а) в сети N назад" в списке участников комнаты (модалка
// "Информация о группе"). NULL — пользователь ни разу не подключался с
// момента добавления этой колонки (аккаунты старше неё).
ensureColumn("users", "lastSeenAt", "INTEGER");

// Момент принятия пользовательского соглашения при регистрации (см.
// /api/register в server.js) — держим как честный аудиторский след, а не
// просто галочку на клиенте. NULL — аккаунт создан до появления этой
// колонки (соглашения при регистрации ещё не было).
ensureColumn("users", "termsAcceptedAt", "INTEGER");

// Дата рождения, указывается один раз при регистрации (см. /api/register
// в server.js — там же проверка возраста 13+, синхронно с текстом
// пользовательского соглашения). Хранится строкой "YYYY-MM-DD" (формат
// нативного <input type="date">), не Unix-таймстампом — дата рождения не
// момент времени, часовой пояс тут не при чём, а строка сравнивается и
// сортируется лексикографически так же корректно, как и по значению.
// Пустая строка — аккаунт создан до появления этого поля.
ensureColumn("users", "birthDate", "TEXT NOT NULL DEFAULT ''");

// Категория группы — фиксированный набор ключей (GROUP_CATEGORY_KEYS в
// server.js), не свободные теги: по совету из дизайн-ревью (см. CLAUDE.md)
// свободные теги потребовали бы нормализации ("#JS"/"js"/"JavaScript") и
// отдельной таблицы many-to-many ради того же результата, который тут даёт
// одна строковая колонка + `WHERE category = ?`. 'other' — дефолт и для
// новых групп без явного выбора, и для групп, созданных до этой колонки.
ensureColumn("groups", "category", "TEXT NOT NULL DEFAULT 'other'");

console.log(`🚀 LÖMO SQLite подключена: ${DB_PATH}`);

export default db;
export { DB_PATH };
