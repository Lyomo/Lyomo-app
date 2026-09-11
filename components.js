// ========================
// LÖMO SHELL-КОМПОНЕНТЫ
// ========================
// Раньше меню/шапка/подвал (тосты+звук) были вручную задублированы в каждом
// HTML-файле — правка одной ссылки в меню означала правку 11 файлов. Теперь
// эта разметка генерируется один раз здесь и подставляется в страницы через
// плейсхолдеры (#sidebarRoot / #headerRoot / #footerRoot).
//
// Обычный скрипт (без сборщика и без type="module"), как и app.js. Подключать
// этот файл нужно ДО app.js — тогда меню/шапка уже будут в DOM к моменту,
// когда app.js вызовет initCommonNav()/initThemeToggle().

// ========================
// ИКОНКИ (инлайн SVG вместо эмодзи)
// ========================
// Один набор на всё приложение — используется и здесь (меню/шапка), и в
// app.js (кнопки действий: лайк, комментарий, прикрепить, удалить и т.д.).
// Классический скрипт без модулей — top-level const/function, объявленные
// здесь, видны в app.js, потому что оба тега <script> подключены в одном
// документе и делят один и тот же "script scope".
const ICON_PATHS = {
  home: '<path d="M3.5 11.5 12 4.5l8.5 7"/><path d="M5.5 10v8.5a1 1 0 0 0 1 1H9a1 1 0 0 0 1-1v-3.5a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v3.5a1 1 0 0 0 1 1h2.5a1 1 0 0 0 1-1V10"/>',
  news: '<rect x="3.6" y="5" width="14.4" height="15" rx="1.4"/><path d="M18 8.2h1.4A1 1 0 0 1 20.4 9.2v9A1.6 1.6 0 0 1 18.8 19.8"/><path d="M6.8 8.8h7.4M6.8 12h7.4M6.8 15.2h4.6"/>',
  account: '<circle cx="12" cy="8.2" r="3.4"/><path d="M4.8 19.8c0-3.7 3.2-6.6 7.2-6.6s7.2 2.9 7.2 6.6"/>',
  friends: '<circle cx="8.8" cy="8.6" r="3"/><circle cx="16.2" cy="9.4" r="2.4"/><path d="M2.8 19.6c0-3.1 2.7-5.6 6-5.6s6 2.5 6 5.6"/><path d="M14.6 14.6c2.5.4 4.4 2.5 4.6 5"/>',
  groups: '<circle cx="8.5" cy="9.4" r="2.9"/><circle cx="16" cy="8" r="2.4"/><path d="M3 19.6c0-3.2 2.5-5.7 5.5-5.7s5.5 2.5 5.5 5.7"/><path d="M13.8 14.2c2.4.5 4.2 2.6 4.2 5.4"/>',
  chats: '<path d="M4 5.8h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H9.2l-4 3.2a.5.5 0 0 1-.8-.4V16H4a1 1 0 0 1-1-1V6.8a1 1 0 0 1 1-1Z"/>',
  music: '<path d="M9.5 17.5V5.8L19 4v11.2"/><circle cx="7" cy="17.8" r="2.4"/><circle cx="16.5" cy="15.8" r="2.4"/>',
  video: '<rect x="3" y="5.2" width="18" height="13.6" rx="2.4"/><path d="M10 9.4v5.2l4.8-2.6Z" fill="currentColor" stroke="none"/>',
  books: '<path d="M4 5.3C4 4.6 4.6 4 5.4 4H11v16H5.4C4.6 20 4 19.4 4 18.7Z"/><path d="M20 5.3c0-.7-.6-1.3-1.4-1.3H13v16h5.6c.8 0 1.4-.6 1.4-1.3Z"/>',
  photos: '<path d="M4 8.6A1.5 1.5 0 0 1 5.5 7.1h1.8l1-1.8h7.4l1 1.8h1.8A1.5 1.5 0 0 1 20 8.6v8.9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.6" r="3.3"/>',
  admin: '<circle cx="12" cy="12" r="3"/><path d="M12 3.2v2.6M12 18.2v2.6M4.3 4.3l1.9 1.9M17.8 17.8l1.9 1.9M2.8 12h2.6M18.6 12h2.6M4.3 19.7l1.9-1.9M17.8 6.2l1.9-1.9"/>',
  users: '<circle cx="9" cy="8.4" r="3"/><path d="M3.3 19.6c0-3.2 2.6-5.7 5.7-5.7s5.7 2.5 5.7 5.7"/><path d="M15.8 8.6a2.6 2.6 0 1 1 0 5.2"/><path d="M19.4 19.6c0-2.5-1.5-4.6-3.7-5.4"/>',
  logout: '<path d="M9.2 4.2H6a1 1 0 0 0-1 1v13.6a1 1 0 0 0 1 1h3.2"/><path d="M13 12h7.2m0 0-3-3m3 3-3 3"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  close: '<path d="M6 6l12 12M18 6 6 18"/>',
  moon: '<path d="M20 14.3A8.4 8.4 0 1 1 9.7 4a7 7 0 0 0 10.3 10.3Z"/>',
  like: '<path d="M12 20.3s-7.3-4.5-9.6-8.8A5.2 5.2 0 0 1 12 6.3a5.2 5.2 0 0 1 9.6 5.2c-2.3 4.3-9.6 8.8-9.6 8.8Z"/>',
  comment: '<path d="M4 5.8h16a1 1 0 0 1 1 1V15a1 1 0 0 1-1 1H9.2l-4 3.2a.5.5 0 0 1-.8-.4V16H4a1 1 0 0 1-1-1V6.8a1 1 0 0 1 1-1Z"/>',
  camera: '<path d="M4 8.6A1.5 1.5 0 0 1 5.5 7.1h1.8l1-1.8h7.4l1 1.8h1.8A1.5 1.5 0 0 1 20 8.6v8.9a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5Z"/><circle cx="12" cy="12.6" r="3.3"/>',
  clip: '<path d="M8.2 12.8V7.2a3.8 3.8 0 0 1 7.6 0v8.6a2.4 2.4 0 0 1-4.8 0V8.6"/>',
  send: '<path d="M4 12 20 4l-6 16-3-6-7-2Z"/>',
  trash: '<path d="M5 7h14M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M7 7l1 12.4A1.6 1.6 0 0 0 9.6 21h4.8a1.6 1.6 0 0 0 1.6-1.6L17 7"/>',
  plus: '<path d="M12 4.5v15M4.5 12h15"/>',
  chevronLeft: '<path d="M15 4.5 7 12l8 7.5"/>',
  chevronRight: '<path d="M9 4.5 17 12l-8 7.5"/>',
  moreVertical: '<circle cx="12" cy="5" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.7" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.7" fill="currentColor" stroke="none"/>',
  play: '<path d="M8 5.5v13l11-6.5Z" fill="currentColor" stroke="none"/>',
  pause: '<rect x="7" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/><rect x="13" y="5" width="4" height="14" rx="1" fill="currentColor" stroke="none"/>',
  call: '<path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1.1-.3 1.2.4 2.5.6 3.8.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.6.6 3.8.1.4 0 .8-.3 1.1L6.6 10.8Z"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 12 0"/><path d="M12 18v3"/>',
  micOff: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M6 11a6 6 0 0 0 10.2 4.5M18 11a6 6 0 0 1-.6 2.6"/><path d="M12 18v3"/><path d="M3.5 3.5l17 17"/>'
};

function icon(name, size) {
  const s = size || 18;
  const body = ICON_PATHS[name] || "";
  return `<svg class="icon icon-${name}" viewBox="0 0 24 24" width="${s}" height="${s}" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

const NAV_ITEMS = [
  { href: "account.html", icon: "account", label: "Мой аккаунт" },
  { href: "index.html",   icon: "news",    label: "Новости" },
  { href: "friends.html", icon: "friends", label: "Друзья" },
  { href: "groups.html",  icon: "groups",  label: "Группы" },
  { href: "chats.html",   icon: "chats",   label: "Чаты" },
  { href: "music.html",   icon: "music",   label: "Музыка" },
  { href: "video.html",   icon: "video",   label: "Видео" },
  { href: "books.html",   icon: "books",   label: "Книги" },
  { href: "photos.html",  icon: "photos",  label: "Фото" }
];

// ========================
// МЕНЮ (сайдбар)
// ========================

function renderMenu() {
  const root = document.getElementById("sidebarRoot");
  if (!root) return;

  root.innerHTML = `
    <div class="sidebar-top">
      <div class="sidebar-logo">
        <div class="logo-circle" title="Свернуть/развернуть меню">LÖ</div>
        <div class="logo-text">
          <div class="logo-title">LÖMO</div>
          <div class="logo-sub">твоя соц-песочница</div>
        </div>
      </div>
      <button type="button" id="sidebarCloseBtn" class="sidebar-close-btn" aria-label="Закрыть меню">${icon("close", 16)}</button>
    </div>
    <div class="sidebar-scroll">
      <ul class="nav-list">
        ${NAV_ITEMS.map(item => `<li><a href="${item.href}" class="nav-link" title="${item.label}"><span class="nav-icon">${icon(item.icon)}</span><span class="nav-label">${item.label}</span></a></li>`).join("")}
      </ul>
      <a href="admin.html" class="nav-admin" style="display:none;" title="Админ"><span class="nav-icon">${icon("admin")}</span><span class="nav-label">Админ</span></a>
      <a href="users.html" class="nav-users" style="display:none;" title="Пользователи"><span class="nav-icon">${icon("users")}</span><span class="nav-label">Пользователи</span></a>
    </div>
    <div id="logoutBtn" class="logout-btn" title="Выйти"><span class="nav-icon">${icon("logout")}</span><span class="nav-label">Выйти</span></div>
  `;
}

// ========================
// ХЕДЕР
// ========================
// Заголовок берётся из <title>LÖMO — Название</title> страницы, чтобы не
// дублировать текст ещё и здесь.

function renderHeader() {
  const root = document.getElementById("headerRoot");
  if (!root) return;

  const parts = document.title.split(" — ");
  const pageTitle = parts.length > 1 ? parts[1] : "LÖMO";

  root.innerHTML = `
    <button type="button" id="menuToggleBtn" class="hamburger-btn" aria-label="Меню">${icon("menu", 20)}</button>
    <h1></h1>
    <div class="actions">
      <label class="switch">
        <input type="checkbox" id="darkToggle">
        <span>${icon("moon", 14)}</span>
      </label>
    </div>
  `;
  root.querySelector("h1").textContent = pageTitle;
}

// ========================
// ФУТЕР (тосты + звук уведомления)
// ========================

function renderFooter() {
  const root = document.getElementById("footerRoot");
  if (!root) return;

  root.innerHTML = `
    <div id="toastContainer"></div>
    <audio id="notifySound" src="Gingle.WAV" preload="auto"></audio>
  `;
}

function renderShell() {
  renderMenu();
  renderHeader();
  renderFooter();
}

renderShell();
