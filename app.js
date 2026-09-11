// ========================
// LÖMO CONFIG
// ========================

// server.js отдаёт и фронтенд, и API с одного и того же origin (никогда
// не были разнесены на разные хосты) — поэтому API_URL/WS_URL всегда
// просто текущий адрес страницы, без хардкода конкретного домена.
// Раньше здесь был хардкод "https://lyomo-1.onrender.com" для всего, что
// не localhost/127.0.0.1 — из-за этого при заходе по IP в локальной сети
// (например, с телефона на http://192.168.x.x:4000) приложение стучалось
// на чужой (давно не обновлявшийся) Render-бэкенд вместо реального
// сервера, и любые запросы (регистрация и т.д.) молча ломались.
const API_URL = `${window.location.protocol}//${window.location.host}`;
const WS_URL = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/ws`;

const STORAGE_USER_KEY   = "lomoUser";
const STORAGE_THEME_KEY  = "lomoTheme";
const STORAGE_ROOMS      = "lomoRooms_";       // + login
const STORAGE_MESSAGES   = "lomoMsgs_";        // + login + "_" + roomId

let currentUser = null;
let currentRoom = "public";
let ws          = null;

// Регистрация service worker'а (sw.js) — нужна, чтобы браузер посчитал
// приложение "устанавливаемым" (PWA) и предложил "Добавить на главный
// экран"/"Установить" на телефоне. Сам sw.js кэширует только статическую
// оболочку (styles.css/app.js/components.js/иконки), не данные — см.
// комментарии в sw.js. После window.load, а не сразу — чтобы не
// конкурировать за сеть с загрузкой самой страницы.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((err) => {
      console.warn("Не удалось зарегистрировать service worker:", err);
    });
  });
}

// ========================
// HELPER: localStorage
// ========================

function saveUser(user) {
  currentUser = user;
  try {
    localStorage.setItem(STORAGE_USER_KEY, JSON.stringify(user));
  } catch (e) {
    console.error("Не удалось сохранить пользователя:", e);
  }
}

function loadUser() {
  if (currentUser) return currentUser;
  try {
    const raw = localStorage.getItem(STORAGE_USER_KEY);
    if (!raw) return null;
    currentUser = JSON.parse(raw);
    return currentUser;
  } catch (e) {
    console.error("Не удалось прочитать пользователя:", e);
    return null;
  }
}

function clearUser() {
  currentUser = null;
  try {
    localStorage.removeItem(STORAGE_USER_KEY);
  } catch (e) {
    console.error("Не удалось очистить localStorage:", e);
  }
}

function getUserKeyPrefix() {
  const u = loadUser();
  return u ? u.login : "guest";
}

function apiStorageKeyRooms() {
  return STORAGE_ROOMS + getUserKeyPrefix();
}

function apiStorageKeyMessages(roomId) {
  return STORAGE_MESSAGES + getUserKeyPrefix() + "_" + roomId;
}

async function apiRequest(path, options = {}) {
  const url = API_URL + path;
  const user = loadUser();
  const isFormData = typeof FormData !== "undefined" && options.body instanceof FormData;
  const opts = {
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      ...(user && user.token ? { Authorization: `Bearer ${user.token}` } : {}),
      ...(options.headers || {})
    },
    ...options
  };
  if (opts.body && !isFormData && typeof opts.body !== "string") {
    opts.body = JSON.stringify(opts.body);
  }

  const res  = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data.error || `Ошибка ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

// ========================
// ТЕМА
// ========================

function applyThemeFromStorage() {
  const theme = localStorage.getItem(STORAGE_THEME_KEY) || "light";
  if (theme === "dark") {
    document.body.classList.add("dark");
  } else {
    document.body.classList.remove("dark");
  }
  const toggle = document.getElementById("darkToggle");
  if (toggle) toggle.checked = theme === "dark";
}

function initThemeToggle() {
  applyThemeFromStorage();
  const toggle = document.getElementById("darkToggle");
  if (!toggle) return;
  toggle.addEventListener("change", () => {
    const isDark = toggle.checked;
    if (isDark) {
      document.body.classList.add("dark");
      localStorage.setItem(STORAGE_THEME_KEY, "dark");
    } else {
      document.body.classList.remove("dark");
      localStorage.setItem(STORAGE_THEME_KEY, "light");
    }
  });
}

// ========================
// МОБИЛЬНОЕ МЕНЮ (бутерброд + выезжающий сайдбар)
// ========================
// Вызывается на КАЖДОЙ странице, включая auth.html (до логина) — поэтому
// не зависит от initCommonNav()/loadUser() и просто ищет .sidebar +
// #menuToggleBtn в DOM, которые есть везде (через components.js или,
// на auth.html, захардкожены статикой).

function initMobileMenu() {
  const sidebar = document.querySelector(".sidebar");
  const toggleBtn = document.getElementById("menuToggleBtn");
  if (!sidebar || !toggleBtn) return;

  let backdrop = document.querySelector(".sidebar-backdrop");
  if (!backdrop) {
    backdrop = document.createElement("div");
    backdrop.className = "sidebar-backdrop";
    document.body.appendChild(backdrop);
  }

  function closeMenu() {
    sidebar.classList.remove("open");
    backdrop.classList.remove("visible");
  }
  function openMenu() {
    sidebar.classList.add("open");
    backdrop.classList.add("visible");
  }

  toggleBtn.addEventListener("click", () => {
    if (sidebar.classList.contains("open")) closeMenu();
    else openMenu();
  });
  backdrop.addEventListener("click", closeMenu);

  const closeBtn = document.getElementById("sidebarCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", closeMenu);

  // Клик по пункту меню на мобильном — закрываем сайдбар, чтобы не
  // закрывать его руками после каждого перехода.
  sidebar.querySelectorAll(".nav-link, .nav-admin, .nav-users, .logout-btn").forEach((el) => {
    el.addEventListener("click", closeMenu);
  });

  // Если экран расширили обратно до десктопа с открытым мобильным меню —
  // сбрасываем классы, иначе .open/.visible могут "залипнуть".
  window.addEventListener("resize", () => {
    if (window.innerWidth > 768) closeMenu();
  });
}

// ========================
// ВЫСОТА ЧАТА НА МОБИЛЬНОМ (экранная клавиатура)
// ========================
// --app-vh — CSS-переменная с реальной высотой видимой области экрана
// (window.visualViewport.height), используется в .chat-layout.chat-open
// (styles.css) вместо 100vh/100dvh. Обычные vh/dvh не решают проблему на
// iOS Safari — там открытие экранной клавиатуры вообще не двигает layout
// viewport (тот, от которого считаются vh-юниты), поэтому чат просто
// оказался бы наполовину скрыт под клавиатурой. visualViewport —
// единственный API, честно отражающий видимую (не перекрытую
// клавиатурой) область на всех современных мобильных браузерах, отсюда
// и подписка на его "resize" (срабатывает и при открытии/закрытии
// клавиатуры, и при повороте экрана).
function initMobileChatViewport() {
  if (!window.visualViewport) return;

  function apply() {
    const vv = window.visualViewport;
    document.documentElement.style.setProperty("--app-vh", vv.height + "px");
    // iOS Safari, открывая клавиатуру на сфокусированном input, сам
    // прокручивает layout viewport, чтобы поле осталось в поле зрения —
    // из-за этого у visualViewport появляется offsetTop > 0. Наш
    // .chat-layout.chat-open зафиксирован через position:fixed относительно
    // layout viewport (а не visual), поэтому без компенсации этого сдвига
    // он "уезжает" вместе со страницей вверх на ту же величину — и поверх
    // уменьшения по высоте получается двойной, слишком резкий скачок.
    document.documentElement.style.setProperty("--app-vh-offset", vv.offsetTop + "px");
  }

  window.visualViewport.addEventListener("resize", apply);
  window.visualViewport.addEventListener("scroll", apply);
  apply();
}

// ========================
// СВОРАЧИВАЕМЫЙ САЙДБАР (десктоп) — клик по лого "LÖ" сворачивает меню
// до одних иконок и обратно (класс .collapsed на .sidebar, см. CSS).
// Состояние — в localStorage: приложение многостраничное (не SPA), без
// сохранения сайдбар разворачивался бы заново при каждом переходе.
// Вызывается безусловно на каждой странице, как и initMobileMenu() —
// на мобильном класс .collapsed ничего не меняет (см. media-запрос в
// styles.css), но сохранённое состояние всё равно синхронизируется на
// случай, если пользователь вернётся на десктоп.
// ========================
const SIDEBAR_COLLAPSE_KEY = "lomoSidebarCollapsed";

function initSidebarCollapse() {
  const sidebar = document.querySelector(".sidebar");
  const logoCircle = document.querySelector(".logo-circle");
  if (!sidebar || !logoCircle) return;

  if (localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1") {
    sidebar.classList.add("collapsed");
  }

  logoCircle.addEventListener("click", () => {
    const collapsed = sidebar.classList.toggle("collapsed");
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0");
  });
}

// ========================
// NAV + LOGOUT
// ========================

function initCommonNav() {
  const user = loadUser();
  if (!user) return;

  const navAdmin = document.querySelector(".nav-admin");
  const navUsers = document.querySelector(".nav-users");
  if (user.isAdmin) {
    if (navAdmin) navAdmin.style.display = "block";
    if (navUsers) navUsers.style.display = "block";
  } else {
    if (navAdmin) navAdmin.style.display = "none";
    if (navUsers) navUsers.style.display = "none";
  }

  const logoutBtn = document.getElementById("logoutBtn");
  if (logoutBtn) {
    logoutBtn.addEventListener("click", () => {
      clearUser();
      window.location.href = "auth.html";
    });
  }

  const links = document.querySelectorAll(".nav-link");
  const path  = window.location.pathname;
  links.forEach((link) => {
    const href = link.getAttribute("href") || "";
    if (href && path.endsWith(href)) {
      link.classList.add("active");
    } else if (href === "index.html" &&
      (path.endsWith("/") || path.endsWith("index.html") || path === "/")) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });
}

// ========================
// AUTH (auth.html)
// ========================

function initAuthPage() {
  applyThemeFromStorage();

  const info   = document.getElementById("authCurrent");
  const goHome = document.getElementById("authGoHome");
  const logout = document.getElementById("authLogout");

  const loginLogin    = document.getElementById("loginLogin");
  const loginPassword = document.getElementById("loginPassword");
  const loginBtn      = document.getElementById("loginBtn");

  const regLogin     = document.getElementById("regLogin");
  const regPassword  = document.getElementById("regPassword");
  const regPassword2 = document.getElementById("regPassword2");
  const regBtn       = document.getElementById("regBtn");

  const user = loadUser();

  if (user) {
    if (info) {
      info.textContent = `Сейчас вы вошли как "${user.login}"` +
        (user.id ? ` (ID: ${user.id}).` : ".");
    }
    if (goHome) {
      goHome.style.display = "inline-block";
      goHome.onclick = () => (window.location.href = "index.html");
    }
    if (logout) {
      logout.style.display = "inline-block";
      logout.onclick = () => {
        clearUser();
        alert("Вы вышли из аккаунта.");
        window.location.reload();
      };
    }
  } else {
    if (info) {
      info.textContent = "Вы ещё не вошли. Создайте логин и пароль или войдите.";
    }
    if (goHome) goHome.style.display = "none";
    if (logout) logout.style.display = "none";
  }

  if (loginBtn && loginLogin && loginPassword) {
    loginBtn.onclick = async () => {
      const login = loginLogin.value.trim();
      const pass  = loginPassword.value.trim();
      if (!login || !pass) {
        alert("Заполни логин и пароль.");
        return;
      }
      try {
        const data = await apiRequest("/api/login", {
          method: "POST",
          body: { login, password: pass }
        });
        saveUser({ login: data.login, id: data.id, isAdmin: data.isAdmin, token: data.token });
        alert(`Привет, ${data.login}!`);
        window.location.href = "index.html";
      } catch (err) {
        console.error(err);
        alert("Ошибка входа: " + err.message);
      }
    };
  }

  if (regBtn && regLogin && regPassword && regPassword2) {
    regBtn.onclick = async () => {
      const login = regLogin.value.trim();
      const pass1 = regPassword.value.trim();
      const pass2 = regPassword2.value.trim();

      if (!login || login.length < 3) {
        alert("Логин минимум 3 символа.");
        return;
      }
      if (!pass1 || pass1.length < 4) {
        alert("Пароль минимум 4 символа.");
        return;
      }
      if (pass1 !== pass2) {
        alert("Пароли не совпадают.");
        return;
      }
      try {
        const data = await apiRequest("/api/register", {
          method: "POST",
          body: { login, password: pass1 }
        });
        saveUser({ login: data.login, id: data.id, isAdmin: data.isAdmin, token: data.token });
        alert(`Аккаунт "${data.login}" создан.\nТвой ID: ${data.id}`);
        window.location.href = "index.html";
      } catch (err) {
        console.error(err);
        alert("Ошибка регистрации: " + err.message);
      }
    };
  }
}

// ========================
// МОЙ АККАУНТ (account.html) — профиль, редактирование, своя стена
// ========================

async function initAccountPage() {
  const user = loadUser();
  if (!user) {
    window.location.href = "auth.html";
    return;
  }

  initCommonNav();
  initThemeToggle();

  const profileName   = document.getElementById("profileName");
  const profileId     = document.getElementById("profileId");
  const profileAbout  = document.getElementById("profileAbout");
  const profileAvatar = document.getElementById("profileAvatar");
  const avatarPh      = document.getElementById("avatarPlaceholder");
  const inputName     = document.getElementById("profileNameInput");
  const inputAbout    = document.getElementById("profileAboutInput");
  const inputAvatar   = document.getElementById("avatarUrlInput");
  const saveBtn       = document.getElementById("saveProfileBtn");
  const avatarEditPreview = document.getElementById("avatarEditPreview");
  const avatarUploadBtn   = document.getElementById("avatarUploadBtn");
  const avatarFileInput   = document.getElementById("avatarFileInput");

  const profileLoginEl = document.getElementById("profileLogin");

  // displayName/avatarUrl/about раньше жили только в localStorage и были
  // не видны никому, кроме вас самих в этом браузере. Теперь это настоящие
  // серверные поля (см. PATCH /api/me) — login при этом НЕ меняется, это
  // фиксированный технический идентификатор (уникальность, вход, WS).
  let profileData = { name: user.login, about: "", avatar: "" };
  try {
    const server = await apiRequest("/api/me");
    profileData.name = server.displayName || user.login;
    profileData.avatar = server.avatarUrl || "";
    profileData.about = server.about || "";
  } catch (e) {
    console.error("Не удалось загрузить профиль с сервера:", e);
  }

  function renderDisplay() {
    if (profileName)  profileName.textContent  = profileData.name || user.login;
    if (profileLoginEl) profileLoginEl.textContent = user.login;
    if (profileId)    profileId.textContent    = user.id || "нет ID";
    if (profileAbout) profileAbout.textContent = profileData.about || "Расскажи о себе :)";

    if (profileAvatar) {
      if (profileData.avatar) {
        profileAvatar.src = profileData.avatar;
        profileAvatar.style.display = "block";
        if (avatarPh) avatarPh.style.display = "none";
      } else {
        profileAvatar.style.display = "none";
        if (avatarPh) avatarPh.style.display = "flex";
      }
    }

    if (avatarEditPreview) {
      if (profileData.avatar) {
        avatarEditPreview.style.backgroundImage = `url("${profileData.avatar}")`;
        avatarEditPreview.textContent = "";
      } else {
        avatarEditPreview.style.backgroundImage = "";
        avatarEditPreview.textContent = (profileData.name || user.login)[0].toUpperCase();
      }
    }
  }

  renderDisplay();

  if (profileAvatar) {
    profileAvatar.addEventListener("click", () => openPhotoLightbox(profileData.avatar));
  }

  if (inputName)   inputName.value   = profileData.name || "";
  if (inputAbout)  inputAbout.value  = profileData.about || "";
  if (inputAvatar) inputAvatar.value = profileData.avatar || "";

  if (avatarUploadBtn && avatarFileInput) {
    avatarUploadBtn.addEventListener("click", () => avatarFileInput.click());
    avatarFileInput.addEventListener("change", async () => {
      const file = avatarFileInput.files && avatarFileInput.files[0];
      if (!file) return;
      avatarUploadBtn.disabled = true;
      try {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
        await apiRequest("/api/me", { method: "PATCH", body: { avatarUrl: uploaded.url } });
        profileData.avatar = uploaded.url;
        if (inputAvatar) inputAvatar.value = uploaded.url;
        renderDisplay();
      } catch (err) {
        alert("Ошибка загрузки фото: " + err.message);
      } finally {
        avatarFileInput.value = "";
        avatarUploadBtn.disabled = false;
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener("click", async () => {
      const newName   = inputName  ? inputName.value.trim()  : "";
      const newAbout  = inputAbout ? inputAbout.value.trim() : "";
      const newAvatar = inputAvatar ? inputAvatar.value.trim() : "";

      profileData.name   = newName;
      profileData.about  = newAbout;
      profileData.avatar = newAvatar;

      try {
        await apiRequest("/api/me", { method: "PATCH", body: { displayName: newName, avatarUrl: newAvatar, about: newAbout } });
      } catch (err) {
        alert("Не удалось сохранить: " + err.message);
        return;
      }

      renderDisplay();
      alert("Профиль обновлён");
    });
  }

  initWall("wallSection", "user", user.id, true);
}

// ========================
// ГЛАВНАЯ (index.html) — сторис + лента публикаций
// ========================

function initHomePage() {
  const user = loadUser();
  if (!user) {
    window.location.href = "auth.html";
    return;
  }
  initCommonNav();
  initThemeToggle();
  initStoriesRow("storiesRow");
  renderFeed("feedSection");
}

function groupStoriesByOwner(stories) {
  const map = new Map();
  stories.forEach((s) => {
    if (!map.has(s.ownerId)) {
      map.set(s.ownerId, { ownerId: s.ownerId, ownerLogin: s.ownerLogin, ownerAvatar: s.ownerAvatar, items: [] });
    }
    map.get(s.ownerId).items.push(s);
  });
  // с сервера истории идут от новых к старым; внутри группы удобнее
  // проигрывать от старой к новой
  map.forEach((g) => g.items.reverse());
  return Array.from(map.values());
}

// Простой полноэкранный просмотр одной картинки (аватар в профиле) —
// в отличие от openStoryViewer() ниже, без навигации между несколькими
// фото и без шапки с именем, просто фото + закрытие.
function openPhotoLightbox(url) {
  if (!url) return;

  const overlay = document.createElement("div");
  overlay.className = "story-viewer-overlay";
  overlay.innerHTML = `
    <div class="story-viewer">
      <div class="story-viewer-header">
        <span></span>
        <button type="button" class="story-viewer-close">${icon("close", 20)}</button>
      </div>
      <img class="story-viewer-img">
    </div>
  `;
  overlay.querySelector(".story-viewer-img").src = url;

  const close = () => overlay.remove();
  overlay.querySelector(".story-viewer-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  document.addEventListener("keydown", function onKey(e) {
    if (e.key === "Escape") { close(); document.removeEventListener("keydown", onKey); }
  });

  document.body.appendChild(overlay);
}

function openStoryViewer(group) {
  let idx = 0;

  const overlay = document.createElement("div");
  overlay.className = "story-viewer-overlay";
  overlay.innerHTML = `
    <div class="story-viewer">
      <div class="story-viewer-header">
        <span class="story-viewer-name"></span>
        <button type="button" class="story-viewer-close">${icon("close", 20)}</button>
      </div>
      <img class="story-viewer-img">
      <button type="button" class="story-viewer-nav story-viewer-prev">${icon("chevronLeft", 20)}</button>
      <button type="button" class="story-viewer-nav story-viewer-next">${icon("chevronRight", 20)}</button>
    </div>
  `;
  overlay.querySelector(".story-viewer-name").textContent = group.ownerLogin;
  const imgEl = overlay.querySelector(".story-viewer-img");

  function render() {
    imgEl.src = group.items[idx].photoUrl;
  }
  render();

  const close = () => overlay.remove();
  overlay.querySelector(".story-viewer-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  overlay.querySelector(".story-viewer-prev").addEventListener("click", () => {
    idx = (idx - 1 + group.items.length) % group.items.length;
    render();
  });
  overlay.querySelector(".story-viewer-next").addEventListener("click", () => {
    idx = (idx + 1) % group.items.length;
    render();
  });

  document.body.appendChild(overlay);
}

function initStoriesRow(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const me = loadUser();

  async function load() {
    container.innerHTML = "";

    const addBubble = document.createElement("div");
    addBubble.className = "story-bubble story-bubble-add";
    addBubble.innerHTML = `
      <div class="story-avatar story-avatar-add">+</div>
      <span class="story-label">Ваша история</span>
      <input type="file" accept="image/*" hidden>
    `;
    const addInput = addBubble.querySelector("input");
    addBubble.addEventListener("click", () => addInput.click());
    addInput.addEventListener("change", async () => {
      const file = addInput.files && addInput.files[0];
      if (!file) return;
      addBubble.style.opacity = "0.6";
      try {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
        await apiRequest("/api/stories", { method: "POST", body: { photoUrl: uploaded.url } });
        addInput.value = "";
        load();
      } catch (err) {
        alert("Ошибка публикации истории: " + err.message);
        addBubble.style.opacity = "1";
      }
    });
    container.appendChild(addBubble);

    try {
      const stories = await apiRequest("/api/stories");
      groupStoriesByOwner(stories).forEach((group) => {
        const bubble = document.createElement("div");
        bubble.className = "story-bubble";
        bubble.innerHTML = `<div class="story-avatar"></div><span class="story-label"></span>`;
        const avatarEl = bubble.querySelector(".story-avatar");
        if (group.ownerAvatar) {
          avatarEl.style.backgroundImage = `url("${group.ownerAvatar}")`;
        } else {
          avatarEl.textContent = (group.ownerLogin || "?")[0].toUpperCase();
        }
        bubble.querySelector(".story-label").textContent = group.ownerId === me.id ? "Вы" : group.ownerLogin;
        bubble.addEventListener("click", () => openStoryViewer(group));
        container.appendChild(bubble);
      });
    } catch (err) {
      const errEl = document.createElement("span");
      errEl.className = "muted";
      errEl.textContent = "Не удалось загрузить истории";
      container.appendChild(errEl);
    }
  }

  load();
}

async function renderFeed(containerId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = "";
  const loading = document.createElement("p");
  loading.className = "muted";
  loading.textContent = "Загрузка...";
  container.appendChild(loading);
  try {
    const posts = await apiRequest("/api/feed");
    container.innerHTML = "";
    if (!posts.length) {
      const empty = document.createElement("p");
      empty.className = "muted";
      empty.textContent = "Лента пуста. Добавьте друзей или вступите в группу, чтобы видеть публикации здесь.";
      container.appendChild(empty);
      return;
    }
    posts.forEach((p) => container.appendChild(renderPostCard(p)));
  } catch (err) {
    container.textContent = "Ошибка загрузки ленты: " + err.message;
  }
}

// ========================
// USERS (users.html)
// ========================

function initUsersPage() {
  const me = loadUser();
  if (!me) {
    window.location.href = "auth.html";
    return;
  }
  initCommonNav();
  initThemeToggle();

  if (!me.isAdmin) {
    const card = document.querySelector(".users-card");
    if (card) card.innerHTML = `<p class="muted">Эта страница доступна только администраторам.</p>`;
    return;
  }

  const tbody = document.getElementById("usersTableBody");
  const countLabel = document.getElementById("usersCountLabel");
  const searchInput = document.getElementById("adminUserSearch");
  const searchBtn = document.getElementById("adminUserSearchBtn");
  if (!tbody) return;

  function renderAvatarEl(u) {
    const span = document.createElement("span");
    span.className = "person-avatar";
    if (u.avatarUrl) {
      span.style.backgroundImage = `url("${u.avatarUrl}")`;
    } else {
      span.textContent = (u.displayName || u.login || "?")[0].toUpperCase();
    }
    return span;
  }

  async function load() {
    tbody.innerHTML = `<tr><td colspan="4" class="muted">Загрузка...</td></tr>`;
    try {
      const q = searchInput ? searchInput.value.trim() : "";
      const users = await apiRequest(`/api/admin/users?q=${encodeURIComponent(q)}`);
      if (countLabel) countLabel.textContent = `Всего: ${users.length}`;
      tbody.innerHTML = "";
      if (!users.length) {
        tbody.innerHTML = `<tr><td colspan="4" class="muted">Никого не найдено.</td></tr>`;
        return;
      }

      users.forEach((u) => {
        const isSelf = u.id === me.id;
        const tr = document.createElement("tr");

        const tdUser = document.createElement("td");
        const userLine = document.createElement("div");
        userLine.className = "admin-user-cell";
        userLine.appendChild(renderAvatarEl(u));
        const nameLink = document.createElement("a");
        nameLink.href = `profile.html?id=${encodeURIComponent(u.id)}`;
        nameLink.textContent = u.displayName || u.login;
        userLine.appendChild(nameLink);
        tdUser.appendChild(userLine);

        const tdLogin = document.createElement("td");
        tdLogin.className = "pwd";
        tdLogin.setAttribute("data-label", "Логин");
        tdLogin.textContent = u.login;

        const tdStatus = document.createElement("td");
        tdStatus.setAttribute("data-label", "Статус");
        if (u.isAdmin) {
          const b = document.createElement("span");
          b.className = "admin-badge admin-badge-admin";
          b.textContent = "Админ";
          tdStatus.appendChild(b);
        }
        if (u.isBanned) {
          const b = document.createElement("span");
          b.className = "admin-badge admin-badge-banned";
          b.textContent = "Забанен";
          tdStatus.appendChild(b);
        }
        if (!u.isAdmin && !u.isBanned) tdStatus.textContent = "—";

        const tdActions = document.createElement("td");
        tdActions.className = "admin-actions-cell";

        const adminBtn = document.createElement("button");
        adminBtn.className = "btn";
        adminBtn.textContent = u.isAdmin ? "Забрать права" : "Сделать админом";
        if (isSelf && u.isAdmin) {
          adminBtn.disabled = true;
          adminBtn.title = "Нельзя снять права администратора с самого себя";
        }
        adminBtn.addEventListener("click", async () => {
          try {
            await apiRequest(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body: { isAdmin: !u.isAdmin } });
            load();
          } catch (err) { alert("Ошибка: " + err.message); }
        });

        const banBtn = document.createElement("button");
        banBtn.className = "btn";
        banBtn.textContent = u.isBanned ? "Разбанить" : "Забанить";
        if (isSelf) banBtn.disabled = true;
        banBtn.addEventListener("click", async () => {
          try {
            await apiRequest(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "PATCH", body: { isBanned: !u.isBanned } });
            load();
          } catch (err) { alert("Ошибка: " + err.message); }
        });

        const delBtn = document.createElement("button");
        delBtn.className = "btn";
        delBtn.textContent = "Удалить";
        if (isSelf) delBtn.disabled = true;
        delBtn.addEventListener("click", async () => {
          if (!confirm(`Удалить аккаунт "${u.login}" безвозвратно? Его посты, комментарии, фото, истории и группы (где он владелец) тоже удалятся.`)) return;
          try {
            await apiRequest(`/api/admin/users/${encodeURIComponent(u.id)}`, { method: "DELETE" });
            load();
          } catch (err) { alert("Ошибка: " + err.message); }
        });

        tdActions.appendChild(adminBtn);
        tdActions.appendChild(banBtn);
        tdActions.appendChild(delBtn);

        tr.appendChild(tdUser);
        tr.appendChild(tdLogin);
        tr.appendChild(tdStatus);
        tr.appendChild(tdActions);
        tbody.appendChild(tr);
      });
    } catch (err) {
      tbody.innerHTML = `<tr><td colspan="4">Ошибка: ${err.message}</td></tr>`;
    }
  }

  if (searchBtn) searchBtn.addEventListener("click", load);
  if (searchInput) {
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); load(); }
    });
  }

  load();
}

// ========================
// АДМИНКА (admin.html) — статистика, модерация постов, группы
// ========================

function initAdminPage() {
  const me = loadUser();
  if (!me) {
    window.location.href = "auth.html";
    return;
  }
  initCommonNav();
  initThemeToggle();

  if (!me.isAdmin) {
    const app = document.querySelector(".app");
    if (app) {
      const notice = document.createElement("p");
      notice.className = "muted";
      notice.textContent = "Эта страница доступна только администраторам.";
      app.appendChild(notice);
    }
    return;
  }

  renderAdminStats();
  renderModerationQueue();
  renderAdminPosts();
  renderAdminGroups();
  renderAdminChatReports();

  const postSearchBtn = document.getElementById("adminPostSearchBtn");
  const postSearchInput = document.getElementById("adminPostSearch");
  if (postSearchBtn) postSearchBtn.addEventListener("click", () => renderAdminPosts());
  if (postSearchInput) {
    postSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); renderAdminPosts(); }
    });
  }
}

async function renderAdminStats() {
  const container = document.getElementById("adminStats");
  if (!container) return;
  try {
    const stats = await apiRequest("/api/admin/stats");
    const labels = {
      users: "Пользователей", admins: "Админов", banned: "Забанено",
      posts: "Постов", comments: "Комментариев", messages: "Сообщений в чате",
      groups: "Групп", photos: "Фото", stories: "Историй"
    };
    container.innerHTML = "";
    Object.keys(labels).forEach((key) => {
      const card = document.createElement("div");
      card.className = "admin-stat-card";
      const value = document.createElement("div");
      value.className = "admin-stat-value";
      value.textContent = stats[key];
      const label = document.createElement("div");
      label.className = "admin-stat-label";
      label.textContent = labels[key];
      card.appendChild(value);
      card.appendChild(label);
      container.appendChild(card);
    });
  } catch (err) {
    container.textContent = "Ошибка загрузки статистики: " + err.message;
  }
}

async function renderAdminPosts() {
  const container = document.getElementById("adminPostsList");
  if (!container) return;
  container.innerHTML = `<p class="muted">Загрузка...</p>`;
  try {
    const searchInput = document.getElementById("adminPostSearch");
    const q = searchInput ? searchInput.value.trim() : "";
    const posts = await apiRequest(`/api/admin/posts?q=${encodeURIComponent(q)}`);
    container.innerHTML = "";
    if (!posts.length) {
      container.innerHTML = `<p class="muted">Ничего не найдено.</p>`;
      return;
    }
    posts.forEach((post) => {
      const card = renderPostCard(post);
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.textContent = "Удалить (модерация)";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Удалить этот пост безвозвратно?")) return;
        try {
          await apiRequest(`/api/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
          card.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      const actions = card.querySelector(".post-actions");
      if (actions) actions.appendChild(delBtn);
      container.appendChild(card);
    });
  } catch (err) {
    container.textContent = "Ошибка загрузки постов: " + err.message;
  }
}

// Очередь постов/комментариев, которые локальный автомодератор (moderation.js
// на сервере) пометил как подозрительные при публикации — скрыты из
// ленты/стены для всех, кроме автора и админа, пока не одобрены здесь.
async function renderModerationQueue() {
  const container = document.getElementById("moderationQueue");
  if (!container) return;
  container.innerHTML = `<p class="muted">Загрузка...</p>`;
  try {
    const { posts, comments } = await apiRequest("/api/admin/moderation");
    container.innerHTML = "";
    if (!posts.length && !comments.length) {
      container.innerHTML = `<p class="muted">Очередь пуста — автомодератор ничего не отметил.</p>`;
      return;
    }
    posts.forEach((post) => {
      const card = renderPostCard(post);
      const approveBtn = document.createElement("button");
      approveBtn.className = "btn primary";
      approveBtn.textContent = "Одобрить";
      approveBtn.addEventListener("click", async () => {
        try {
          await apiRequest(`/api/admin/posts/${encodeURIComponent(post.id)}/approve`, { method: "PATCH" });
          card.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.textContent = "Удалить";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Удалить этот пост безвозвратно?")) return;
        try {
          await apiRequest(`/api/posts/${encodeURIComponent(post.id)}`, { method: "DELETE" });
          card.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      const actions = card.querySelector(".post-actions");
      if (actions) { actions.appendChild(approveBtn); actions.appendChild(delBtn); }
      container.appendChild(card);
    });
    comments.forEach((c) => {
      const row = document.createElement("div");
      row.className = "moderation-comment-row";
      const author = document.createElement("span");
      author.className = "comment-author";
      author.textContent = c.authorName + ": ";
      const text = document.createElement("span");
      text.textContent = c.text;
      const reason = document.createElement("div");
      reason.className = "moderation-reason";
      reason.textContent = "Причина: " + (c.moderationReason || "—");
      row.appendChild(author);
      row.appendChild(text);
      row.appendChild(reason);

      const actions = document.createElement("div");
      actions.className = "moderation-comment-actions";
      const approveBtn = document.createElement("button");
      approveBtn.className = "btn primary";
      approveBtn.textContent = "Одобрить";
      approveBtn.addEventListener("click", async () => {
        try {
          await apiRequest(`/api/admin/comments/${encodeURIComponent(c.id)}/approve`, { method: "PATCH" });
          row.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.textContent = "Удалить";
      delBtn.addEventListener("click", async () => {
        if (!confirm("Удалить этот комментарий безвозвратно?")) return;
        try {
          await apiRequest(`/api/comments/${encodeURIComponent(c.id)}`, { method: "DELETE" });
          row.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      actions.appendChild(approveBtn);
      actions.appendChild(delBtn);
      row.appendChild(actions);
      container.appendChild(row);
    });
  } catch (err) {
    container.textContent = "Ошибка загрузки очереди модерации: " + err.message;
  }
}

async function renderAdminGroups() {
  const container = document.getElementById("adminGroupsList");
  if (!container) return;
  container.innerHTML = `<p class="muted">Загрузка...</p>`;
  try {
    const groups = await apiRequest("/api/admin/groups");
    container.innerHTML = "";
    if (!groups.length) {
      container.innerHTML = `<p class="muted">Групп пока нет.</p>`;
      return;
    }
    groups.forEach((g) => {
      const card = renderGroupCard(g);
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.style.marginTop = "8px";
      delBtn.textContent = "Удалить группу";
      delBtn.addEventListener("click", async () => {
        if (!confirm(`Удалить группу "${g.name}" безвозвратно?`)) return;
        try {
          await apiRequest(`/api/groups/${encodeURIComponent(g.id)}`, { method: "DELETE" });
          card.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      card.appendChild(delBtn);
      container.appendChild(card);
    });
  } catch (err) {
    container.textContent = "Ошибка загрузки групп: " + err.message;
  }
}

async function renderAdminChatReports() {
  const container = document.getElementById("adminChatReportsList");
  if (!container) return;
  container.innerHTML = `<p class="muted">Загрузка...</p>`;
  try {
    const reports = await apiRequest("/api/admin/chat-reports");
    container.innerHTML = "";
    if (!reports.length) {
      container.innerHTML = `<p class="muted">Жалоб нет.</p>`;
      return;
    }
    reports.forEach((r) => {
      const row = document.createElement("div");
      row.className = "moderation-comment-row";
      const header = document.createElement("div");
      const reporterSpan = document.createElement("span");
      reporterSpan.className = "comment-author";
      reporterSpan.textContent = r.reporterName;
      const roomCode = document.createElement("code");
      roomCode.className = "pwd";
      roomCode.textContent = r.room;
      header.appendChild(reporterSpan);
      header.appendChild(document.createTextNode(" пожаловался(-лась) на комнату "));
      header.appendChild(roomCode);
      const date = document.createElement("div");
      date.className = "meta";
      date.textContent = new Date(r.createdAt).toLocaleString("ru-RU");
      row.appendChild(header);
      row.appendChild(date);
      if (r.note) {
        const note = document.createElement("div");
        note.style.marginTop = "6px";
        note.textContent = r.note;
        row.appendChild(note);
      }
      const actions = document.createElement("div");
      actions.className = "moderation-comment-actions";
      const delBtn = document.createElement("button");
      delBtn.className = "btn";
      delBtn.textContent = "Отметить рассмотренной";
      delBtn.addEventListener("click", async () => {
        try {
          await apiRequest(`/api/admin/chat-reports/${encodeURIComponent(r.id)}`, { method: "DELETE" });
          row.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      });
      actions.appendChild(delBtn);
      row.appendChild(actions);
      container.appendChild(row);
    });
  } catch (err) {
    container.textContent = "Ошибка загрузки жалоб: " + err.message;
  }
}

// ========================
// MEDIA PAGES (music / video / books)
// ========================

function initMediaPage(type) {
  const user = loadUser();
  if (!user) {
    window.location.href = "auth.html";
    return;
  }
  initCommonNav();
  initThemeToggle();

  const input = document.getElementById(`${type}Input`);
  const btn   = document.getElementById(`${type}Add`);
  const list  = document.getElementById(`${type}List`);
  if (!input || !btn || !list) return;

  const STORAGE_KEY = `lomoMedia_${type}_${user.login}`;

  function loadMedia() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }

  function saveMedia(items) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
    } catch {}
  }

  function render() {
    const items = loadMedia();
    list.innerHTML = "";
    items.forEach((item, idx) => {
      const li   = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = item;
      const del  = document.createElement("button");
      del.className = "btn";
      del.innerHTML = icon("trash", 14);
      del.addEventListener("click", () => {
        const arr = loadMedia();
        arr.splice(idx, 1);
        saveMedia(arr);
        render();
      });
      li.appendChild(span);
      li.appendChild(del);
      list.appendChild(li);
    });
  }

  btn.addEventListener("click", () => {
    const val = input.value.trim();
    if (!val) return;
    const arr = loadMedia();
    arr.push(val);
    saveMedia(arr);
    input.value = "";
    render();
  });

  render();
}

// ========================
// CHAT STORAGE
// ========================

function loadRoomsForUser() {
  try {
    const raw = localStorage.getItem(apiStorageKeyRooms());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveRoomsForUser(rooms) {
  try {
    localStorage.setItem(apiStorageKeyRooms(), JSON.stringify(rooms));
  } catch {}
}

function loadMessages(roomId) {
  try {
    const raw = localStorage.getItem(apiStorageKeyMessages(roomId));
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

function saveMessages(roomId, msgs) {
  try {
    localStorage.setItem(apiStorageKeyMessages(roomId), JSON.stringify(msgs));
  } catch {}
}

// ========================
// TOAST + SOUND + NOTIFICATION
// ========================

function showToast(from, text) {
  const container = document.getElementById("toastContainer");
  if (!container) return;

  const el = document.createElement("div");
  el.className = "toast";

  const title = document.createElement("div");
  title.className = "toast-title";
  title.textContent = `Сообщение от ${from}`;

  const body = document.createElement("div");
  body.className = "toast-text";
  const shortText = text && text.length > 80 ? text.slice(0, 77) + "..." : (text || "");
  body.textContent = shortText || "Новое сообщение";

  el.appendChild(title);
  el.appendChild(body);

  container.appendChild(el);

  setTimeout(() => {
    el.classList.add("hide");
    setTimeout(() => {
      if (el.parentNode === container) {
        container.removeChild(el);
      }
    }, 250);
  }, 4000);

  const audio = document.getElementById("notifySound");
  if (audio) {
    try {
      audio.currentTime = 0;
      audio.play().catch(() => {});
    } catch (e) {
      console.warn("Не удалось проиграть звук уведомления:", e);
    }
  }
}

function tryShowNotification(from, text) {
  // Всегда — тост + звук
  showToast(from, text);

  if (typeof Notification === "undefined") return;

  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
  if (Notification.permission !== "granted") return;
  if (!document.hidden) return;

  const body =
    text && text.length > 80 ? text.slice(0, 77) + "..." : (text || "");

  new Notification(`Новое сообщение от ${from}`, {
    body
  });
}

// ========================
// CHAT UI HELPERS
// ========================

function isImageFileName(name) {
  return /\.(jpe?g|png|gif|webp)$/i.test(name || "");
}

function renderChatAttachment(fileUrl, fileName) {
  const wrap = document.createElement("div");
  wrap.className = "msg-attachment";
  if (isImageFileName(fileName || fileUrl)) {
    const img = document.createElement("img");
    img.className = "msg-attachment-img";
    img.src = fileUrl;
    wrap.appendChild(img);
  } else {
    const link = document.createElement("a");
    link.className = "msg-attachment-file";
    link.href = fileUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.innerHTML = icon("clip", 14);
    link.appendChild(document.createTextNode(" " + (fileName || "файл")));
    wrap.appendChild(link);
  }
  return wrap;
}

// Кто получает аватар/имя — см. комментарий у .msg-row в styles.css:
// своё сообщение — никогда; чужое в личном диалоге — только аватар;
// чужое в комнате/группе — аватар И имя (раскладка пузырей/колонки по
// ширине экрана решается чисто в CSS, сюда не относится).
function appendMessageToLog({ id, from, displayName, text, ts, isMe, system, fileUrl, fileName, avatar, pollData, checklistData }) {
  const logEl = document.getElementById("log");
  if (!logEl) return;

  const isDm = currentRoom.startsWith("dm-");

  const row = document.createElement("div");
  row.className = "msg-row" + (isMe ? " me" : "") + (system ? " system" : "");

  if (!system && !isMe && avatar) {
    const avatarEl = document.createElement("div");
    avatarEl.className = "msg-avatar";
    avatarEl.style.backgroundImage = `url("${avatar}")`;
    row.appendChild(avatarEl);
  }

  const bubble = document.createElement("div");
  bubble.className = "msg-bubble";
  if (id) bubble.dataset.messageId = id;

  if (system) {
    const meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = from || "Система";
    bubble.appendChild(meta);
  } else if (!isMe && !isDm && displayName) {
    // Имя — только у чужих сообщений в комнате (см. комментарий выше),
    // остаётся сверху пузыря. Время сообщения — отдельным элементом
    // .msg-time, опущено в правый нижний угол пузыря (см. CSS), как в
    // обычных мессенджерах, а не над текстом вместе с именем.
    const name = document.createElement("div");
    name.className = "meta";
    name.textContent = displayName;
    bubble.appendChild(name);
  }

  if (text) {
    const body = document.createElement("div");
    body.className = "text";
    body.textContent = text;
    bubble.appendChild(body);
  }

  if (fileUrl) {
    bubble.appendChild(renderChatAttachment(fileUrl, fileName));
  }

  if (pollData) {
    bubble.appendChild(renderPollBlock(pollData, id));
  }

  if (checklistData) {
    bubble.appendChild(renderChecklistBlock(checklistData, id));
  }

  if (!system) {
    const dt = ts ? new Date(ts) : new Date();
    const time = document.createElement("div");
    time.className = "msg-time";
    time.textContent = dt.toTimeString().slice(0, 5);
    bubble.appendChild(time);
  }

  row.appendChild(bubble);
  logEl.appendChild(row);

  logEl.scrollTop = logEl.scrollHeight;
}

// Опрос как блок внутри сообщения — варианты кликабельны (голос шлётся по
// WS, см. voteOnPoll), заливка и проценты честно считаются от суммы
// голосов, свой голос подсвечен рамкой (.voted-by-me).
function renderPollBlock(pollData, messageId) {
  const wrap = document.createElement("div");
  wrap.className = "poll-message";

  const q = document.createElement("div");
  q.className = "poll-question";
  q.textContent = pollData.question;
  wrap.appendChild(q);

  const me = loadUser();
  const totalVotes = pollData.options.reduce((sum, o) => sum + o.votes.length, 0);

  pollData.options.forEach((opt, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poll-option";
    const votedByMe = !!(me && opt.votes.includes(me.login));
    if (votedByMe) btn.classList.add("voted-by-me");
    const pct = totalVotes ? Math.round((opt.votes.length / totalVotes) * 100) : 0;

    const fill = document.createElement("div");
    fill.className = "poll-option-fill";
    fill.style.width = pct + "%";
    btn.appendChild(fill);

    const label = document.createElement("div");
    label.className = "poll-option-label";
    const textSpan = document.createElement("span");
    textSpan.textContent = opt.text;
    const countSpan = document.createElement("span");
    countSpan.textContent = `${opt.votes.length} (${pct}%)`;
    label.appendChild(textSpan);
    label.appendChild(countSpan);
    btn.appendChild(label);

    btn.addEventListener("click", () => voteOnPoll(messageId, idx));
    wrap.appendChild(btn);
  });

  const total = document.createElement("div");
  total.className = "poll-total";
  total.textContent = `Всего голосов: ${totalVotes}`;
  wrap.appendChild(total);

  return wrap;
}

function voteOnPoll(messageId, optionIndex) {
  if (!messageId) { alert("Опрос ещё загружается, попробуйте через секунду."); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  ws.send(JSON.stringify({ type: "vote", room: currentRoom, messageId, optionIndex }));
}

// Приходит по WS всем в комнате после любого голоса (см. server.js,
// msg.type==="vote") — перерисовывает конкретный опрос на месте, без
// перезагрузки всего лога сообщений.
function updatePollUI(messageId, pollData) {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  const wrapper = logEl.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!wrapper) return;
  const old = wrapper.querySelector(".poll-message");
  if (old) old.remove();
  wrapper.appendChild(renderPollBlock(pollData, messageId));
}

// Список задач как блок внутри сообщения — каждый пункт независимая
// галочка, которую может поставить/снять ЛЮБОЙ участник комнаты (общее
// состояние, не как голос в опросе, который принадлежит только тебе).
// checkedBy показывает, кто отметил пункт последним.
function renderChecklistBlock(checklistData, messageId) {
  const wrap = document.createElement("div");
  wrap.className = "checklist-message";

  const title = document.createElement("div");
  title.className = "checklist-title";
  title.textContent = checklistData.title;
  wrap.appendChild(title);

  checklistData.items.forEach((item, idx) => {
    const row = document.createElement("label");
    row.className = "checklist-item" + (item.checked ? " checked" : "");

    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = !!item.checked;
    box.addEventListener("change", () => toggleChecklistItem(messageId, idx));
    row.appendChild(box);

    const textSpan = document.createElement("span");
    textSpan.className = "checklist-item-text";
    textSpan.textContent = item.text;
    row.appendChild(textSpan);

    if (item.checked && item.checkedBy) {
      const byEl = document.createElement("span");
      byEl.className = "checklist-item-by";
      byEl.textContent = item.checkedBy;
      row.appendChild(byEl);
    }

    wrap.appendChild(row);

    // Трекер времени — отдельно от <label> с галочкой (иначе клик по
    // кнопке заодно снимал бы/ставил галочку через bubbling к label).
    // "Сколько у кого времени ушло" — старт/стоп персонально у каждого
    // (свой накопленный totalSeconds), но разбивка по людям видна всем.
    const me = loadUser();
    const timers = item.timers || [];
    const myTimer = me && timers.find((t) => t.login === me.login);
    const isRunning = !!(myTimer && myTimer.runningSince);

    const timerRow = document.createElement("div");
    timerRow.className = "checklist-timer-row";

    const timerBtn = document.createElement("button");
    timerBtn.type = "button";
    timerBtn.className = "checklist-timer-btn" + (isRunning ? " running" : "");
    timerBtn.innerHTML = icon(isRunning ? "pause" : "play", 12);
    timerBtn.appendChild(document.createTextNode(isRunning ? " Стоп" : " Трекер"));
    timerBtn.addEventListener("click", () => toggleChecklistTimer(messageId, idx));
    timerRow.appendChild(timerBtn);

    const breakdown = document.createElement("div");
    breakdown.className = "checklist-timer-breakdown";
    if (messageId) breakdown.dataset.messageId = messageId;
    breakdown.dataset.itemIndex = String(idx);
    renderTimerBreakdown(breakdown, timers);
    timerRow.appendChild(breakdown);

    wrap.appendChild(timerRow);
  });

  return wrap;
}

// mm:ss / Hч Mм — компактно, без лишней точности до секунд на больших
// значениях (никому не интересны секунды в "3ч 14м").
function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}ч ${m}м`;
  if (m > 0) return `${m}м ${sec}с`;
  return `${sec}с`;
}

// Рисует разбивку "кто сколько времени потратил" на конкретном пункте —
// вызывается и при первом рендере, и каждую секунду тикающим интервалом
// (см. startChecklistTicker) для всех, у кого таймер сейчас идёт.
function renderTimerBreakdown(el, timers) {
  el.innerHTML = "";
  let anyRunning = false;
  timers.forEach((t) => {
    if (!t.totalSeconds && !t.runningSince) return;
    const seconds = (t.totalSeconds || 0) + (t.runningSince ? (Date.now() - t.runningSince) / 1000 : 0);
    const span = document.createElement("span");
    span.className = "checklist-timer-entry" + (t.runningSince ? " running" : "");
    span.textContent = `${t.displayName}: ${formatDuration(seconds)}`;
    el.appendChild(span);
    if (t.runningSince) anyRunning = true;
  });
  el.dataset.hasRunning = anyRunning ? "true" : "false";
}

let checklistTickInterval = null;

// Один общий интервал на всю страницу — ищет видимые разбивки с активным
// таймером и досчитывает "сколько идёт прямо сейчас" от runningSince,
// беря актуальные данные из локального кэша сообщений (его обновляет
// updateChecklistUI на каждый checklistUpdate по WS). Не плодит по
// интервалу на каждый список — они все тикают от одного таймера.
function startChecklistTicker() {
  if (checklistTickInterval) return;
  checklistTickInterval = setInterval(() => {
    document.querySelectorAll('.checklist-timer-breakdown[data-has-running="true"]').forEach((el) => {
      const messageId = el.dataset.messageId;
      const itemIndex = Number(el.dataset.itemIndex);
      const msgs = loadMessages(currentRoom);
      const cached = msgs.find((m) => m.id === messageId);
      if (!cached || !cached.checklistData) return;
      const item = cached.checklistData.items[itemIndex];
      if (!item) return;
      renderTimerBreakdown(el, item.timers || []);
    });
  }, 1000);
}

function toggleChecklistItem(messageId, itemIndex) {
  if (!messageId) { alert("Список ещё загружается, попробуйте через секунду."); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  ws.send(JSON.stringify({ type: "checklistToggle", room: currentRoom, messageId, itemIndex }));
}

function toggleChecklistTimer(messageId, itemIndex) {
  if (!messageId) { alert("Список ещё загружается, попробуйте через секунду."); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  ws.send(JSON.stringify({ type: "checklistTimerToggle", room: currentRoom, messageId, itemIndex }));
}

// Приходит по WS всем в комнате после того, как кто-то поставил/снял
// галочку (см. server.js, msg.type==="checklistToggle") — перерисовывает
// конкретный список на месте.
function updateChecklistUI(messageId, checklistData) {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  const wrapper = logEl.querySelector(`[data-message-id="${CSS.escape(messageId)}"]`);
  if (!wrapper) return;
  const old = wrapper.querySelector(".checklist-message");
  if (old) old.remove();
  wrapper.appendChild(renderChecklistBlock(checklistData, messageId));
}

function setStatusOnline(isOnline) {
  const subtitle = document.getElementById("chatHeaderSubtitle");
  if (!subtitle) return;
  if (!isOnline) {
    subtitle.textContent = "нет соединения";
    subtitle.classList.remove("online");
  }
  // Если isOnline===true — ничего не пишем: точный текст ("N в сети")
  // придёт следующим сообщением от сервера типа "presence" (см.
  // updateRoomPresence) сразу после подключения, писать здесь заглушку
  // вроде просто "в сети" бессмысленно — через мгновение всё равно
  // перезапишется реальным числом.
}

// Реальное число людей, сейчас подключённых к текущей комнате (WS
// сервер шлёт это при каждом подключении/отключении кого-либо — см.
// broadcastPresence() в server.js). Не "участники беседы" в смысле
// членства (такой сущности в модели чата нет), а честный live-счётчик.
// Используется только для КОМНАТ/групп — для личных диалогов вместо
// этого статус собеседника (см. applyDmPeerStatus() ниже): "N в сети"
// бессмысленно для чата один на один, там либо 0, либо 1.
function updateRoomPresence(count) {
  const subtitle = document.getElementById("chatHeaderSubtitle");
  if (!subtitle) return;
  subtitle.textContent = `${count} в сети`;
  subtitle.classList.toggle("online", count > 0);
}

// Статус собеседника в личном диалоге — три состояния вместо счётчика
// (см. broadcastDmPeerStatuses() в server.js): "reading" — собеседник
// прямо сейчас держит открытым ЭТОТ диалог, "online" — подключён к
// приложению, но не в этом диалоге, "offline"/null — нигде. "Печатает..."
// (см. showTypingIndicator() ниже) временно перекрывает этот текст и
// сам возвращает его назад по таймеру — поэтому dmPeerStatus хранится
// отдельно от того, что сейчас в DOM.
let dmPeerStatus = null;
let typingRevertTimer = null;
const DM_STATUS_LABELS = { online: "В сети", reading: "Читает", offline: "" };

function renderDmStatusText() {
  const subtitle = document.getElementById("chatHeaderSubtitle");
  if (!subtitle) return;
  subtitle.textContent = DM_STATUS_LABELS[dmPeerStatus] || "";
  subtitle.classList.toggle("online", dmPeerStatus === "online" || dmPeerStatus === "reading");
}

function applyDmPeerStatus(status) {
  dmPeerStatus = status;
  // Пока висит "Печатает..." — не перетираем его новым статусом, он и
  // так вернётся сам, как только истечёт таймер в showTypingIndicator().
  if (!typingRevertTimer) renderDmStatusText();
}

function showTypingIndicator() {
  const subtitle = document.getElementById("chatHeaderSubtitle");
  if (!subtitle) return;
  subtitle.textContent = "Печатает...";
  subtitle.classList.add("online");
  if (typingRevertTimer) clearTimeout(typingRevertTimer);
  typingRevertTimer = setTimeout(() => {
    typingRevertTimer = null;
    renderDmStatusText();
  }, 3000);
}

// Шапка чата: аватар + имя собеседника (для диалога dm-*) или название
// беседы/комнаты — как в Telegram, вместо "текущий пользователь".
function updateChatHeader() {
  const titleEl = document.getElementById("chatHeaderTitle");
  const avatarEl = document.getElementById("chatHeaderAvatar");
  if (!titleEl || !avatarEl) return;

  ensureRoomsLoaded();
  const room = roomsLocal.find((r) => r.id === currentRoom);

  let displayName = room ? room.title : currentRoom;
  if (currentRoom.startsWith("dm-")) {
    if (room && room.peerLogin) {
      displayName = room.peerLogin;
    } else if (room) {
      displayName = room.title.replace(/^Диалог с /, "");
    }
  }
  displayName = displayName || "Чат";

  titleEl.textContent = displayName;
  if (room && room.avatarUrl) {
    avatarEl.style.backgroundImage = `url("${room.avatarUrl}")`;
    avatarEl.textContent = "";
  } else {
    avatarEl.style.backgroundImage = "";
    avatarEl.textContent = displayName[0].toUpperCase();
  }

  const callBtn = document.getElementById("chatCallBtn");
  if (callBtn) callBtn.hidden = !currentRoom.startsWith("dm-");

  // Для DM статус собеседника рисуем сразу (даже "пусто", пока не пришёл
  // реальный peerStatus с сервера) — иначе на секунду мелькал бы
  // текст/счётчик, оставшийся от предыдущей открытой комнаты.
  if (currentRoom.startsWith("dm-")) renderDmStatusText();

  applyWallpaper();
  applyCopyProtection();
  renderChatMenu();
}

// ========================
// МЕНЮ ЧАТА (три точки) — разный набор пунктов для группы/комнаты и для
// личного диалога, как в телеграме. Часть пунктов телеграма сюда осознанно
// НЕ перенесена — "Информация о группе"/"Управление группой" (у комнат
// нет настоящего членства/ролей — это просто WS-канал по строке-id, не
// сущность в БД), "Создать опрос" (нет модели опросов), "Создать список"
// (нет смысла при паре диалогов), "Пожаловаться" (нет пайплайна разбора
// жалоб на переписку). Всё, что оставлено, — либо уже есть в приложении,
// либо честно реализуемо на клиенте без новых выдуманных сущностей.

function getRoomById(id) {
  ensureRoomsLoaded();
  return roomsLocal.find((r) => r.id === id);
}

function saveRoomMeta(id, patch) {
  const room = getRoomById(id);
  if (!room) return;
  Object.assign(room, patch);
  saveRoomsForUser(roomsLocal);
}

// dm-<userA>-<userB> — id пользователей без дефисов (6 цифр + 2 буквы),
// поэтому просто режем префикс и делим по "-".
function getDmPeerId(roomId) {
  const me = loadUser();
  if (!me || !roomId.startsWith("dm-")) return null;
  const parts = roomId.slice(3).split("-");
  return parts.find((id) => id !== me.id) || null;
}

function applyWallpaper() {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  const room = getRoomById(currentRoom);
  if (room && room.wallpaperUrl) {
    logEl.style.backgroundImage = `url("${room.wallpaperUrl}")`;
    logEl.style.backgroundSize = "cover";
    logEl.style.backgroundPosition = "center";
  } else {
    logEl.style.backgroundImage = "";
  }
}

function applyCopyProtection() {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  const room = getRoomById(currentRoom);
  const disabled = !!(room && room.copyDisabled);
  logEl.classList.toggle("no-copy", disabled);
  logEl.oncopy = disabled ? (e) => e.preventDefault() : null;
}

function downloadTextFile(filename, text) {
  const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportCurrentHistory() {
  const msgs = loadMessages(currentRoom);
  const titleEl = document.getElementById("chatHeaderTitle");
  const title = (titleEl && titleEl.textContent) || "chat";
  const lines = msgs.map((m) => {
    const time = new Date(m.ts).toLocaleString("ru-RU");
    const author = m.displayName || m.from || "?";
    const text = m.text || (m.fileUrl ? `[файл: ${m.fileName || m.fileUrl}]` : "");
    return `[${time}] ${author}: ${text}`;
  });
  downloadTextFile(`${title}.txt`, lines.join("\n") || "Сообщений пока нет.");
}

function clearCurrentHistory() {
  if (!confirm("Очистить историю сообщений в этом чате? Это сотрёт её только у вас на этом устройстве.")) return;
  saveMessages(currentRoom, []);
  renderMessagesForCurrentRoom();
  renderRoomsList();
}

function deleteCurrentRoom() {
  const titleEl = document.getElementById("chatHeaderTitle");
  const title = (titleEl && titleEl.textContent) || "этот чат";
  if (!confirm(`Удалить чат "${title}" из списка?`)) return;
  // Для настоящих комнат/групп (не DM) это ещё и "Покинуть" из новой
  // модалки "Информация о группе" — убирает членство (chat_room_members),
  // чтобы человек не оставался в списке участников после ухода. Best-effort:
  // если запрос не прошёл, локальное удаление всё равно происходит —
  // это лишь список для UI, а не право доступа к чему-либо.
  if (!currentRoom.startsWith("dm-")) {
    apiRequest(`/api/chat-rooms/${encodeURIComponent(currentRoom)}/leave`, { method: "POST" }).catch(() => {});
  }
  ensureRoomsLoaded();
  roomsLocal = roomsLocal.filter((r) => r.id !== currentRoom);
  let next = roomsLocal[0];
  if (!next) {
    next = { id: "public", title: "Общий чат" };
    roomsLocal = [next];
  }
  saveRoomsForUser(roomsLocal);
  const layout = document.querySelector(".chat-layout");
  if (layout) layout.classList.remove("chat-open");
  switchRoom(next.id);
}

// Все раскрывающиеся панели в чате (обои/инфо/управление/опрос/жалоба)
// взаимоисключающие — открытие одной прячет остальные, чтобы не громоздить
// несколько форм друг над другом.
function hideAllChatPanels() {
  ["wallpaperForm", "groupManageForm", "pollForm", "checklistForm", "reportForm"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.hidden = true;
  });
}

// Визитка собеседника — по клику на имя в шапке личного диалога (как в
// телеграме), всплывает поверх чата, никуда не уводя со страницы. Для
// комнаты/группы своей визитки нет — переиспользуем "Информацию о
// группе" (см. вызов в initChatPage()). Данные — те же, что и на
// profile.html (GET /api/user-by-id/:id), плюс мини-версия кнопки
// дружбы (полная логика — в initProfilePage(), тут короче, т.к. места
// в модалке меньше).
async function openChatPeerCard() {
  if (!currentRoom.startsWith("dm-")) {
    showGroupInfoModal();
    return;
  }
  const peerId = getDmPeerId(currentRoom);
  if (!peerId) return;

  let target;
  try {
    target = await apiRequest(`/api/user-by-id/${encodeURIComponent(peerId)}`);
  } catch (err) {
    alert("Не удалось загрузить профиль: " + err.message);
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "story-viewer-overlay";
  overlay.innerHTML = `
    <div class="contact-card">
      <button type="button" class="contact-card-close">${icon("close", 18)}</button>
      <div class="contact-card-avatar-wrap"></div>
      <div class="contact-card-name"></div>
      <div class="contact-card-id"></div>
      <div class="contact-card-about" hidden></div>
      <div class="contact-card-actions"></div>
    </div>
  `;

  const name = target.displayName || target.login;
  overlay.querySelector(".contact-card-name").textContent = name;
  overlay.querySelector(".contact-card-id").textContent = `ID: ${target.id}`;

  if (target.about) {
    const aboutEl = overlay.querySelector(".contact-card-about");
    aboutEl.textContent = target.about;
    aboutEl.hidden = false;
  }

  const avatarWrap = overlay.querySelector(".contact-card-avatar-wrap");
  if (target.avatarUrl) {
    const img = document.createElement("img");
    img.className = "contact-card-avatar";
    img.src = target.avatarUrl;
    img.addEventListener("click", () => openPhotoLightbox(target.avatarUrl));
    avatarWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "contact-card-avatar contact-card-avatar-placeholder";
    ph.textContent = (name || "?")[0].toUpperCase();
    avatarWrap.appendChild(ph);
  }

  const actions = overlay.querySelector(".contact-card-actions");
  const profileLink = document.createElement("a");
  profileLink.className = "btn";
  profileLink.textContent = "Открыть профиль";
  profileLink.href = `profile.html?id=${encodeURIComponent(target.id)}`;
  actions.appendChild(profileLink);

  const me = loadUser();
  if (me && me.id !== target.id) {
    const friendBtn = document.createElement("button");
    friendBtn.type = "button";
    friendBtn.className = "btn";
    friendBtn.textContent = "…";
    actions.appendChild(friendBtn);

    async function refreshFriendBtn() {
      let status;
      try {
        status = (await apiRequest(`/api/friends/status/${encodeURIComponent(target.id)}`)).status;
      } catch (err) { return; }
      friendBtn.textContent = FRIEND_STATUS_LABELS[status] || "…";
      friendBtn.classList.toggle("primary", status === "none");
      friendBtn.onclick = async () => {
        try {
          if (status === "incoming") await apiRequest(`/api/friends/accept/${encodeURIComponent(target.id)}`, { method: "POST" });
          else if (status === "none") await apiRequest(`/api/friends/request/${encodeURIComponent(target.id)}`, { method: "POST" });
          else await apiRequest(`/api/friends/decline/${encodeURIComponent(target.id)}`, { method: "POST" });
          refreshFriendBtn();
        } catch (err) { alert("Ошибка: " + err.message); }
      };
    }
    refreshFriendBtn();
  }

  const close = () => overlay.remove();
  overlay.querySelector(".contact-card-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  document.body.appendChild(overlay);
}

// "Информация о группе" — модалка по клику на название чата (как в
// телеграме), заменяет прежнюю текстовую панель. Данные — GET
// /api/chat-rooms/:id/members: честный список участников (кто реально хоть
// раз открывал эту комнату, chat_room_members — не выдуманное число) со
// статусом "в сети"/"был(а) N назад", и честные счётчики медиа по истории
// сообщений этой комнаты. Быстрые действия сверху (Звук/Управление/
// Покинуть/Ещё) — то же самое, что раньше было в общем "⋮"-меню чата,
// вынесено сюда, т.к. по факту это и есть основной способ туда попасть.
async function showGroupInfoModal() {
  if (currentRoom.startsWith("dm-")) return;

  let data;
  try {
    data = await apiRequest(`/api/chat-rooms/${encodeURIComponent(currentRoom)}/members`);
  } catch (err) {
    alert("Не удалось загрузить информацию о группе: " + err.message);
    return;
  }

  const overlay = document.createElement("div");
  overlay.className = "story-viewer-overlay";
  overlay.innerHTML = `
    <div class="group-modal">
      <button type="button" class="contact-card-close">${icon("close", 18)}</button>
      <div class="group-modal-avatar-wrap"></div>
      <div class="group-modal-name"></div>
      <div class="group-modal-count"></div>
      <div class="group-modal-actions"></div>
      <div class="group-modal-stats"></div>
      <div class="group-modal-members"></div>
    </div>
  `;
  const modalEl = overlay.querySelector(".group-modal");

  const avatarWrap = overlay.querySelector(".group-modal-avatar-wrap");
  if (data.avatarUrl) {
    const img = document.createElement("img");
    img.className = "contact-card-avatar";
    img.src = data.avatarUrl;
    img.addEventListener("click", () => openPhotoLightbox(data.avatarUrl));
    avatarWrap.appendChild(img);
  } else {
    const ph = document.createElement("div");
    ph.className = "contact-card-avatar contact-card-avatar-placeholder";
    ph.textContent = (data.name || "?")[0].toUpperCase();
    avatarWrap.appendChild(ph);
  }

  overlay.querySelector(".group-modal-name").textContent = data.name;
  overlay.querySelector(".group-modal-count").textContent =
    `${data.members.length} ${pluralRu(data.members.length, "участник", "участника", "участников")}`;

  // Быстрые действия
  const room = getRoomById(currentRoom);
  const muted = !!(room && room.muted);
  const actionsEl = overlay.querySelector(".group-modal-actions");

  function actionBtn(iconName, label, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "group-modal-action-btn";
    btn.innerHTML = `${icon(iconName, 20)}<span>${label}</span>`;
    btn.addEventListener("click", onClick);
    return btn;
  }

  actionsEl.appendChild(actionBtn(muted ? "bellOff" : "bell", muted ? "Без звука" : "Звук", () => {
    saveRoomMeta(currentRoom, { muted: !muted });
    overlay.remove();
    showGroupInfoModal();
  }));
  actionsEl.appendChild(actionBtn("admin", "Управление", () => {
    overlay.remove();
    showGroupManage();
  }));
  actionsEl.appendChild(actionBtn("logout", "Покинуть", () => {
    overlay.remove();
    deleteCurrentRoom();
  }));

  const moreMenu = document.createElement("div");
  moreMenu.className = "group-modal-more-menu";
  moreMenu.hidden = true;
  [
    ["Создать опрос", showPollForm],
    ["Создать список", showChecklistForm],
    ["Экспорт истории чата", exportCurrentHistory],
    ["Очистить историю", clearCurrentHistory],
    ["Пожаловаться", () => { hideAllChatPanels(); const f = document.getElementById("reportForm"); if (f) f.hidden = false; }]
  ].forEach(([label, action]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "group-modal-more-item";
    b.textContent = label;
    b.addEventListener("click", () => { overlay.remove(); action(); });
    moreMenu.appendChild(b);
  });
  const moreBtn = actionBtn("moreVertical", "Ещё", (e) => {
    e.stopPropagation();
    moreMenu.hidden = !moreMenu.hidden;
  });
  actionsEl.appendChild(moreBtn);
  // ВАЖНО: добавляем ВНУТРЬ .group-modal-actions (не после неё) — иначе
  // .group-modal-actions{position:relative} не был бы offset-родителем
  // для этого dropdown'а (offset-родитель ищется среди ПРЕДКОВ, не
  // соседей), и top:calc(100%+4px) считался бы от ближайшего позиционированного
  // предка выше — .story-viewer-overlay{position:fixed;inset:0}, то есть
  // от всего экрана целиком, и меню уезжало бы к самому низу viewport'а.
  actionsEl.appendChild(moreMenu);

  // Счётчики медиа — честные, посчитаны на сервере по истории сообщений
  // ЭТОЙ комнаты (roomMediaCounts() в server.js), без выдуманных чисел.
  const statsEl = overlay.querySelector(".group-modal-stats");
  [
    { key: "photos", icon: "photos", label: (n) => pluralRu(n, "фотография", "фотографии", "фотографий") },
    { key: "videos", icon: "video", label: () => "видео" },
    { key: "files", icon: "clip", label: (n) => pluralRu(n, "файл", "файла", "файлов") },
    { key: "links", icon: "link", label: (n) => pluralRu(n, "ссылка", "ссылки", "ссылок") }
  ].forEach((def) => {
    const n = (data.counts && data.counts[def.key]) || 0;
    const row = document.createElement("div");
    row.className = "group-modal-stat-row";
    const iconWrap = document.createElement("span");
    iconWrap.className = "group-modal-stat-icon";
    iconWrap.innerHTML = icon(def.icon, 18);
    const text = document.createElement("span");
    text.textContent = `${n} ${def.label(n)}`;
    row.appendChild(iconWrap);
    row.appendChild(text);
    statsEl.appendChild(row);
  });

  // Список участников — настоящее членство (chat_room_members), не
  // выдуманное число: попадает сюда каждый, кто хоть раз открывал именно
  // эту комнату (см. wss.on("connection") в server.js).
  const membersEl = overlay.querySelector(".group-modal-members");
  const membersHeader = document.createElement("div");
  membersHeader.className = "group-modal-members-header";
  membersHeader.textContent = `${data.members.length} ${pluralRu(data.members.length, "участник", "участника", "участников")}`.toUpperCase();
  membersEl.appendChild(membersHeader);

  if (!data.members.length) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "Пока никто не заходил в этот чат.";
    membersEl.appendChild(empty);
  } else {
    data.members.forEach((m) => {
      const row = document.createElement("a");
      row.className = "group-modal-member-row";
      row.href = `profile.html?id=${encodeURIComponent(m.id)}`;

      const avatar = document.createElement("span");
      avatar.className = "group-modal-member-avatar";
      if (m.avatarUrl) {
        avatar.style.backgroundImage = `url("${m.avatarUrl}")`;
      } else {
        avatar.textContent = (m.displayName || "?")[0].toUpperCase();
      }

      const info = document.createElement("span");
      info.className = "group-modal-member-info";
      const nameEl = document.createElement("span");
      nameEl.className = "group-modal-member-name";
      nameEl.textContent = m.displayName;
      const statusEl = document.createElement("span");
      statusEl.className = "group-modal-member-status" + (m.online ? " online" : "");
      statusEl.textContent = m.online ? "в сети" : formatLastSeen(m.lastSeenAt);
      info.appendChild(nameEl);
      info.appendChild(statusEl);

      row.appendChild(avatar);
      row.appendChild(info);
      membersEl.appendChild(row);
    });
  }

  const close = () => { document.removeEventListener("keydown", onKeydown); overlay.remove(); };
  function onKeydown(e) { if (e.key === "Escape") close(); }
  overlay.querySelector(".contact-card-close").addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });
  modalEl.addEventListener("click", (e) => {
    if (!moreMenu.contains(e.target) && e.target !== moreBtn && !moreBtn.contains(e.target)) moreMenu.hidden = true;
  });
  document.addEventListener("keydown", onKeydown);

  document.body.appendChild(overlay);
}

// "Управление группой" — переименовать/сменить аватар комнаты. Требует,
// чтобы комната была зарегистрирована на сервере (см. registerChatRoomOnServer)
// и что управляет ей её создатель (или админ) — иначе PATCH вернёт 403.
function updateManageRoomAvatarPreview() {
  const preview = document.getElementById("manageRoomAvatarPreview");
  const avatarInput = document.getElementById("manageRoomAvatar");
  if (!preview || !avatarInput) return;
  const url = avatarInput.value.trim();
  if (url) {
    preview.style.backgroundImage = `url("${url}")`;
    preview.textContent = "";
  } else {
    preview.style.backgroundImage = "";
    preview.textContent = "?";
  }
}

async function showGroupManage() {
  hideAllChatPanels();
  const form = document.getElementById("groupManageForm");
  const nameInput = document.getElementById("manageRoomName");
  const avatarInput = document.getElementById("manageRoomAvatar");
  if (!form || !nameInput || !avatarInput) return;
  form.hidden = false;
  const room = getRoomById(currentRoom);
  nameInput.value = (room && room.title) || "";
  avatarInput.value = (room && room.avatarUrl) || "";
  try {
    const serverInfo = await apiRequest(`/api/chat-rooms/${encodeURIComponent(currentRoom)}`);
    nameInput.value = serverInfo.name;
    avatarInput.value = serverInfo.avatarUrl || "";
  } catch (e) {
    // комната не зарегистрирована на сервере (напр. создана до этой фичи) —
    // сохранение просто зарегистрирует её сейчас, см. saveGroupManage()
  }
  updateManageRoomAvatarPreview();
  nameInput.focus();
}

async function saveGroupManage() {
  const nameInput = document.getElementById("manageRoomName");
  const avatarInput = document.getElementById("manageRoomAvatar");
  if (!nameInput) return;
  const name = nameInput.value.trim();
  if (!name) { alert("Укажите название"); return; }
  const avatarUrl = avatarInput ? avatarInput.value.trim() : "";
  try {
    // на случай, если комната создана до появления карточек на сервере
    await apiRequest("/api/chat-rooms", { method: "POST", body: { id: currentRoom, name } });
    const updated = await apiRequest(`/api/chat-rooms/${encodeURIComponent(currentRoom)}`, { method: "PATCH", body: { name, avatarUrl } });
    saveRoomMeta(currentRoom, { title: updated.name, avatarUrl: updated.avatarUrl });
    renderRoomsList();
    updateChatHeader();
    updateManageRoomAvatarPreview();
    document.getElementById("groupManageForm").hidden = true;
  } catch (err) { alert("Ошибка: " + err.message); }
}

function showPollForm() {
  hideAllChatPanels();
  const form = document.getElementById("pollForm");
  const optionsWrap = document.getElementById("pollOptions");
  const question = document.getElementById("pollQuestion");
  if (!form) return;
  form.hidden = false;
  if (question) question.value = "";
  if (optionsWrap) {
    optionsWrap.innerHTML = "";
    for (let i = 0; i < 2; i++) addPollOptionInput();
  }
  if (question) question.focus();
}

function addPollOptionInput() {
  const optionsWrap = document.getElementById("pollOptions");
  if (!optionsWrap) return;
  const input = document.createElement("input");
  input.className = "poll-option-input";
  input.placeholder = `Вариант ${optionsWrap.children.length + 1}`;
  optionsWrap.appendChild(input);
}

function createPollFromForm() {
  const question = document.getElementById("pollQuestion");
  const optionsWrap = document.getElementById("pollOptions");
  if (!question || !optionsWrap) return;
  const q = question.value.trim();
  const options = Array.from(optionsWrap.querySelectorAll(".poll-option-input"))
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!q) { alert("Укажите вопрос"); return; }
  if (options.length < 2) { alert("Нужно минимум 2 варианта ответа"); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  ws.send(JSON.stringify({ type: "poll", room: currentRoom, question: q, options }));
  document.getElementById("pollForm").hidden = true;
}

// "Список" = сообщение-чеклист (список задач с галочками, которые может
// ставить/снимать ЛЮБОЙ участник комнаты — общее состояние, не личный
// выбор, как в голосовании опроса). Форма — тот же паттерн, что у опроса.
function showChecklistForm() {
  hideAllChatPanels();
  const form = document.getElementById("checklistForm");
  const itemsWrap = document.getElementById("checklistItems");
  const title = document.getElementById("checklistTitle");
  if (!form) return;
  form.hidden = false;
  if (title) title.value = "";
  if (itemsWrap) {
    itemsWrap.innerHTML = "";
    for (let i = 0; i < 2; i++) addChecklistItemInput();
  }
  if (title) title.focus();
}

function addChecklistItemInput() {
  const itemsWrap = document.getElementById("checklistItems");
  if (!itemsWrap) return;
  const input = document.createElement("input");
  input.className = "checklist-item-input";
  input.placeholder = `Пункт ${itemsWrap.children.length + 1}`;
  itemsWrap.appendChild(input);
}

function createChecklistFromForm() {
  const title = document.getElementById("checklistTitle");
  const itemsWrap = document.getElementById("checklistItems");
  if (!title || !itemsWrap) return;
  const t = title.value.trim();
  const items = Array.from(itemsWrap.querySelectorAll(".checklist-item-input"))
    .map((i) => i.value.trim())
    .filter(Boolean);
  if (!t) { alert("Укажите название списка"); return; }
  if (!items.length) { alert("Добавьте хотя бы один пункт"); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  ws.send(JSON.stringify({ type: "checklist", room: currentRoom, title: t, items }));
  document.getElementById("checklistForm").hidden = true;
}

function sendReportFromForm() {
  const noteEl = document.getElementById("reportNote");
  const note = noteEl ? noteEl.value.trim() : "";
  apiRequest("/api/chat-reports", { method: "POST", body: { room: currentRoom, note } })
    .then(() => {
      alert("Жалоба отправлена администрации.");
      if (noteEl) noteEl.value = "";
      document.getElementById("reportForm").hidden = true;
    })
    .catch((err) => alert("Ошибка: " + err.message));
}

function renderChatMenu() {
  const dropdown = document.getElementById("chatMenuDropdown");
  if (!dropdown) return;

  const isDm = currentRoom.startsWith("dm-");
  const room = getRoomById(currentRoom);
  const muted = !!(room && room.muted);

  const items = [];

  items.push({
    label: muted ? "Включить уведомления" : "Выключить уведомления",
    action: () => { saveRoomMeta(currentRoom, { muted: !muted }); renderChatMenu(); }
  });

  if (isDm) {
    const peerId = getDmPeerId(currentRoom);
    if (peerId) {
      items.push({ label: "Показать профиль", action: () => {
        window.location.href = `profile.html?id=${encodeURIComponent(peerId)}`;
      }});
    }

    const hasWallpaper = !!(room && room.wallpaperUrl);
    items.push({ label: hasWallpaper ? "Изменить обои" : "Установить обои", action: () => {
      hideAllChatPanels();
      const form = document.getElementById("wallpaperForm");
      const input = document.getElementById("wallpaperUrlInput");
      if (form && input) {
        input.value = (room && room.wallpaperUrl) || "";
        form.hidden = false;
        input.focus();
      }
    }});

    const copyDisabled = !!(room && room.copyDisabled);
    items.push({ label: copyDisabled ? "Разрешить копирование" : "Запретить копирование", action: () => {
      saveRoomMeta(currentRoom, { copyDisabled: !copyDisabled });
      applyCopyProtection();
      renderChatMenu();
    }});
  } else {
    // "Информация о группе" раньше была отдельным пунктом здесь — теперь
    // по клику на само название чата открывается новая модалка
    // (showGroupInfoModal(), см. openChatPeerCard()), дублировать пункт
    // в этом меню больше не нужно.
    items.push({ label: "Управление группой", action: showGroupManage });
    items.push({ label: "Создать опрос", action: showPollForm });
    items.push({ label: "Создать список", action: showChecklistForm });
  }

  items.push({ label: "Экспорт истории чата", action: exportCurrentHistory });
  items.push({ label: "Очистить историю", action: clearCurrentHistory });
  if (!isDm) items.push({ label: "Пожаловаться", action: () => { hideAllChatPanels(); const f = document.getElementById("reportForm"); if (f) f.hidden = false; } });
  items.push({ label: isDm ? "Удалить чат" : "Удалить и покинуть", action: deleteCurrentRoom, danger: true });

  dropdown.innerHTML = "";
  items.forEach((item) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chat-menu-item" + (item.danger ? " danger" : "");
    btn.textContent = item.label;
    btn.addEventListener("click", () => {
      dropdown.hidden = true;
      item.action();
    });
    dropdown.appendChild(btn);
  });
}

// ========================
// WS
// ========================

let roomsLocal = [];
let wsReconnectTimer = null;
const WS_RECONNECT_DELAY = 3000;

function ensureRoomsLoaded() {
  if (roomsLocal && roomsLocal.length) return;
  const saved = loadRoomsForUser();
  if (saved && saved.length) {
    roomsLocal = saved;
  } else {
    roomsLocal = [{ id: "public", title: "Общий чат" }];
    saveRoomsForUser(roomsLocal);
  }
}

// ========================
// ЗВОНКИ (аудио через WebRTC)
// ========================
// Голос идёт НАПРЯМУЮ между браузерами (WebRTC, P2P) — сервер участвует
// только в "сигналинге" (обмен offer/answer/ICE-кандидатами через уже
// существующий WebSocket, см. новые типы сообщений call-* в server.js).
// Обработка входящих call-* сообщений подключена в connectWebSocket()
// ниже и работает на ЛЮБОЙ странице (WS глобальный) — сам UI звонка это
// оверлей, создаваемый прямо в JS (по образцу openPhotoLightbox()), а не
// часть разметки конкретной страницы, иначе входящий звонок был бы не
// виден нигде, кроме chats.html. Кнопка "позвонить" при этом есть только
// в шапке личного диалога в chats.html (см. initChatPage()) — групповые
// звонки не делаем, это отдельная, гораздо более сложная фича.
//
// ВАЖНОЕ ОГРАНИЧЕНИЕ (осознанное, для MVP): проект — многостраничное
// приложение (обычные переходы между .html, не SPA), поэтому звонок
// физически не может "пережить" переход на другую страницу — вся JS-
// память (включая RTCPeerConnection) уничтожается браузером при обычной
// навигации, как и при перезагрузке вкладки. beforeunload ниже
// best-effort шлёт call-end собеседнику, чтобы у него не остался
// зависший "идёт разговор", но сам звонок в любом случае обрывается —
// не переходить на другую страницу во время звонка на этом и держится.
// TURN-сервера нет (только публичный STUN) — за особо строгим NAT
// (часть корпоративных сетей) звонок может не установиться; для
// надёжной работы везде нужен свой/платный TURN, см. известные проблемы
// в начале файла.

const CALL_MESSAGE_TYPES = new Set(["call-offer", "call-answer", "call-ice", "call-reject", "call-end", "call-busy", "call-unavailable"]);
const CALL_ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }, { urls: "stun:stun1.l.google.com:19302" }];

let activeCall = null;
let callTimerInterval = null;

function removeCallOverlay() {
  const el = document.getElementById("callOverlay");
  if (el) el.remove();
  const audioEl = document.getElementById("callRemoteAudio");
  if (audioEl) audioEl.remove();
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
}

function startCallTimer() {
  if (!activeCall) return;
  activeCall.startedAt = activeCall.startedAt || Date.now();
  callTimerInterval = setInterval(() => {
    const el = document.getElementById("callTimer");
    if (!el || !activeCall) return;
    const sec = Math.floor((Date.now() - activeCall.startedAt) / 1000);
    const mm = String(Math.floor(sec / 60)).padStart(2, "0");
    const ss = String(sec % 60).padStart(2, "0");
    el.textContent = `${mm}:${ss}`;
  }, 1000);
}

function renderCallOverlay() {
  removeCallOverlay();
  if (!activeCall) return;

  const overlay = document.createElement("div");
  overlay.id = "callOverlay";
  overlay.className = "call-overlay";

  const name = activeCall.peerDisplayName || "?";
  const avatarHtml = activeCall.peerAvatar
    ? `<img class="call-avatar" src="${activeCall.peerAvatar}" alt="">`
    : `<div class="call-avatar call-avatar-placeholder">${name[0].toUpperCase()}</div>`;

  let statusHtml = "";
  let actionsHtml = "";
  if (activeCall.status === "outgoing") {
    statusHtml = "Звоним...";
    actionsHtml = `<button type="button" class="call-btn call-btn-end" id="callCancelBtn" title="Отменить">${icon("call", 24)}</button>`;
  } else if (activeCall.status === "incoming") {
    statusHtml = "Входящий звонок";
    actionsHtml = `
      <button type="button" class="call-btn call-btn-decline" id="callDeclineBtn" title="Отклонить">${icon("call", 24)}</button>
      <button type="button" class="call-btn call-btn-accept" id="callAcceptBtn" title="Принять">${icon("call", 24)}</button>
    `;
  } else if (activeCall.status === "connected") {
    statusHtml = `<span id="callTimer">00:00</span>`;
    actionsHtml = `
      <button type="button" class="call-btn call-btn-mute" id="callMuteBtn" title="Микрофон">${icon("mic", 20)}</button>
      <button type="button" class="call-btn call-btn-end" id="callHangupBtn" title="Завершить">${icon("call", 24)}</button>
    `;
  } else {
    statusHtml = activeCall.statusMessage || "";
  }

  overlay.innerHTML = `
    <div class="call-card">
      ${avatarHtml}
      <div class="call-name"></div>
      <div class="call-status">${statusHtml}</div>
      <div class="call-actions">${actionsHtml}</div>
    </div>
  `;
  overlay.querySelector(".call-name").textContent = name;

  document.body.appendChild(overlay);

  if (activeCall.status === "outgoing") {
    document.getElementById("callCancelBtn").addEventListener("click", () => endCall("Звонок отменён"));
  } else if (activeCall.status === "incoming") {
    document.getElementById("callAcceptBtn").addEventListener("click", acceptCall);
    document.getElementById("callDeclineBtn").addEventListener("click", declineCall);
  } else if (activeCall.status === "connected") {
    document.getElementById("callHangupBtn").addEventListener("click", () => endCall("Звонок завершён"));
    const muteBtn = document.getElementById("callMuteBtn");
    muteBtn.addEventListener("click", () => {
      if (!activeCall || !activeCall.localStream) return;
      activeCall.muted = !activeCall.muted;
      activeCall.localStream.getAudioTracks().forEach((t) => { t.enabled = !activeCall.muted; });
      muteBtn.innerHTML = icon(activeCall.muted ? "micOff" : "mic", 20);
      muteBtn.classList.toggle("active", activeCall.muted);
    });
    startCallTimer();
  }
}

function sendCallSignal(type, extra) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type, ...extra }));
}

function createCallPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: CALL_ICE_SERVERS });

  pc.addEventListener("icecandidate", (e) => {
    if (e.candidate && activeCall) {
      sendCallSignal("call-ice", { to: activeCall.peerLogin, callId: activeCall.callId, candidate: e.candidate });
    }
  });

  pc.addEventListener("track", (e) => {
    if (!activeCall) return;
    let audioEl = document.getElementById("callRemoteAudio");
    if (!audioEl) {
      audioEl = document.createElement("audio");
      audioEl.id = "callRemoteAudio";
      audioEl.autoplay = true;
      audioEl.playsInline = true;
      audioEl.hidden = true;
      document.body.appendChild(audioEl);
    }
    audioEl.srcObject = e.streams[0];
    // `autoplay` одного `<audio>` не всегда достаточно на мобильных
    // (особенно iOS Safari) — даже после пользовательского жеста, которым
    // был начат звонок, воспроизведение может не стартовать само. Явный
    // play() — без него звонок "соединяется", но собеседника не слышно.
    audioEl.play().catch((err) => console.warn("Не удалось запустить воспроизведение звонка:", err));
  });

  pc.addEventListener("connectionstatechange", () => {
    if (!activeCall || activeCall.pc !== pc) return;
    if (pc.connectionState === "connected" && activeCall.status !== "connected") {
      activeCall.status = "connected";
      renderCallOverlay();
    }
    if ((pc.connectionState === "failed" || pc.connectionState === "disconnected") && activeCall.status === "connected") {
      endCall("Соединение потеряно");
    }
  });

  return pc;
}

async function startCall(peerLogin, peerDisplayName, peerAvatar) {
  if (activeCall) { alert("Уже есть активный звонок"); return; }
  if (!ws || ws.readyState !== WebSocket.OPEN) { alert("Нет подключения к чату"); return; }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    alert("Этот браузер не поддерживает звонки");
    return;
  }

  const callId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()));
  activeCall = {
    callId, peerLogin, peerDisplayName, peerAvatar,
    isCaller: true, status: "outgoing", muted: false, pendingCandidates: []
  };
  renderCallOverlay();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    cleanupCall("Нет доступа к микрофону");
    return;
  }
  if (!activeCall) { stream.getTracks().forEach((t) => t.stop()); return; }
  activeCall.localStream = stream;

  const pc = createCallPeerConnection();
  activeCall.pc = pc;
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  sendCallSignal("call-offer", { to: peerLogin, callId, sdp: offer, video: false });
}

async function acceptCall() {
  if (!activeCall || activeCall.status !== "incoming") return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    declineCall();
    alert("Нет доступа к микрофону");
    return;
  }
  if (!activeCall) { stream.getTracks().forEach((t) => t.stop()); return; }
  activeCall.localStream = stream;

  const pc = createCallPeerConnection();
  activeCall.pc = pc;
  stream.getTracks().forEach((t) => pc.addTrack(t, stream));

  await pc.setRemoteDescription(new RTCSessionDescription(activeCall.offerSdp));
  for (const candidate of activeCall.pendingCandidates) {
    try { await pc.addIceCandidate(candidate); } catch (e) { /* кандидат устарел — не критично */ }
  }
  activeCall.pendingCandidates = [];

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  sendCallSignal("call-answer", { to: activeCall.peerLogin, callId: activeCall.callId, sdp: answer });

  activeCall.status = "connected";
  renderCallOverlay();
}

function declineCall() {
  if (!activeCall) return;
  sendCallSignal("call-reject", { to: activeCall.peerLogin, callId: activeCall.callId });
  cleanupCall();
}

function endCall(message) {
  if (activeCall) {
    sendCallSignal("call-end", { to: activeCall.peerLogin, callId: activeCall.callId });
  }
  cleanupCall(message);
}

function cleanupCall(message) {
  const prev = activeCall;
  if (prev) {
    if (prev.pc) { try { prev.pc.close(); } catch (e) {} }
    if (prev.localStream) prev.localStream.getTracks().forEach((t) => t.stop());
  }

  if (message) {
    activeCall = { status: "ended", statusMessage: message, peerDisplayName: prev ? prev.peerDisplayName : "", peerAvatar: prev ? prev.peerAvatar : "" };
    renderCallOverlay();
    setTimeout(() => {
      if (activeCall && activeCall.status === "ended") { activeCall = null; removeCallOverlay(); }
    }, 2500);
  } else {
    activeCall = null;
    removeCallOverlay();
  }
}

// Входящие call-* сообщения — вызывается из connectWebSocket() ниже для
// ЛЮБОГО сообщения с type из CALL_MESSAGE_TYPES, независимо от того,
// какая страница/комната сейчас открыта (звонок — не часть конкретного
// чата, это отдельная сущность поверх всего приложения).
async function handleCallSignal(msg) {
  if (msg.type === "call-offer") {
    if (activeCall) {
      // Уже говорим/звоним — отвечаем "занято", чтобы у звонящего не
      // висели вечные гудки в никуда.
      sendCallSignal("call-busy", { to: msg.from, callId: msg.callId });
      return;
    }
    activeCall = {
      callId: msg.callId, peerLogin: msg.from, peerDisplayName: msg.fromDisplayName, peerAvatar: msg.fromAvatar,
      isCaller: false, status: "incoming", muted: false,
      offerSdp: msg.sdp, pendingCandidates: []
    };
    renderCallOverlay();
    const sound = document.getElementById("notifySound");
    if (sound) { try { sound.play().catch(() => {}); } catch (e) {} }
    return;
  }

  if (!activeCall || msg.callId !== activeCall.callId) return;

  if (msg.type === "call-answer") {
    if (!activeCall.pc) return;
    await activeCall.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    for (const candidate of activeCall.pendingCandidates) {
      try { await activeCall.pc.addIceCandidate(candidate); } catch (e) { /* кандидат устарел — не критично */ }
    }
    activeCall.pendingCandidates = [];
    activeCall.status = "connected";
    renderCallOverlay();
    return;
  }

  if (msg.type === "call-ice") {
    if (!msg.candidate) return;
    if (activeCall.pc && activeCall.pc.remoteDescription) {
      try { await activeCall.pc.addIceCandidate(msg.candidate); } catch (e) { /* кандидат устарел — не критично */ }
    } else {
      activeCall.pendingCandidates.push(msg.candidate);
    }
    return;
  }

  if (msg.type === "call-reject") { cleanupCall("Собеседник отклонил звонок"); return; }
  if (msg.type === "call-busy") { cleanupCall("Собеседник сейчас занят"); return; }
  if (msg.type === "call-unavailable") { cleanupCall("Собеседник не в сети"); return; }
  if (msg.type === "call-end") { cleanupCall("Звонок завершён"); return; }
}

// Best-effort — предупреждаем собеседника, что звонок обрывается, если
// уходим со страницы посреди разговора (см. ограничение выше).
window.addEventListener("beforeunload", () => {
  if (activeCall && activeCall.callId && activeCall.status !== "ended") {
    sendCallSignal("call-end", { to: activeCall.peerLogin, callId: activeCall.callId });
  }
});

function connectWebSocket() {
  const user = loadUser();
  if (!user) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  if (wsReconnectTimer) {
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = null;
  }

  const url = `${WS_URL}?login=${encodeURIComponent(user.login)}&room=${encodeURIComponent(currentRoom)}`;
  ws = new WebSocket(url);

  ws.addEventListener("open", () => {
    console.log("WS connected:", currentRoom);
    setStatusOnline(true);
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch (err) {
      console.warn("Некорректный WS JSON:", err);
      return;
    }

    if (msg.type === "presence") {
      // Счётчик "N в сети" — только для комнат/групп; у личных диалогов
      // вместо него статус собеседника (см. "peerStatus" ниже).
      if (msg.room === currentRoom && !currentRoom.startsWith("dm-")) updateRoomPresence(msg.count);
      return;
    }

    if (msg.type === "peerStatus") {
      if (msg.room === currentRoom) applyDmPeerStatus(msg.status);
      return;
    }

    if (msg.type === "typing") {
      if (msg.room === currentRoom && currentRoom.startsWith("dm-")) showTypingIndicator();
      return;
    }

    if (CALL_MESSAGE_TYPES.has(msg.type)) {
      handleCallSignal(msg);
      return;
    }

    if (msg.type === "roomUpdate") {
      saveRoomMeta(msg.room, { title: msg.name, avatarUrl: msg.avatarUrl });
      renderRoomsList();
      if (msg.room === currentRoom) updateChatHeader();
      return;
    }

    if (msg.type === "pollUpdate") {
      // обновляем и кэш (чтобы после перезагрузки страницы остались
      // актуальные голоса), и, если сообщение сейчас на экране, саму разметку
      const cached = loadMessages(msg.room);
      const target = cached.find((m) => m.id === msg.messageId);
      if (target) { target.pollData = msg.pollData; saveMessages(msg.room, cached); }
      if (msg.room === currentRoom) updatePollUI(msg.messageId, msg.pollData);
      return;
    }

    if (msg.type === "checklistUpdate") {
      const cached = loadMessages(msg.room);
      const target = cached.find((m) => m.id === msg.messageId);
      if (target) { target.checklistData = msg.checklistData; saveMessages(msg.room, cached); }
      if (msg.room === currentRoom) updateChecklistUI(msg.messageId, msg.checklistData);
      return;
    }

    if (msg.type === "history") {
      // Сервер шлёт последние 50 сообщений комнаты сразу после подключения
      // (см. wss.on("connection", ...) в server.js) — раньше этот тип
      // сообщения нигде не обрабатывался на клиенте (падал в пустоту),
      // из-за чего история чата была видна ТОЛЬКО если сообщения пришли
      // по WS, пока клиент уже был подключён — новый человек (или чужое
      // устройство/браузер без локального кэша) не видел вообще ничего
      // из прошлой переписки, хотя на сервере она была. Мержим с уже
      // сохранённым локальным кэшем по id сообщения (не затираем целиком —
      // на всякий случай, если в кэше есть что-то без ещё не
      // синхронизированного id).
      const roomId = currentRoom;
      const incoming = Array.isArray(msg.data) ? msg.data : [];
      const local = loadMessages(roomId);
      const withoutId = local.filter((m) => m.id == null);
      const byId = new Map();
      local.forEach((m) => { if (m.id != null) byId.set(m.id, m); });
      incoming.forEach((m) => {
        byId.set(m.id, {
          id: m.id, from: m.from, displayName: m.fromDisplayName || m.from, text: m.text, ts: m.ts,
          fileUrl: m.fileUrl || null, fileName: m.fileName || null, avatar: m.avatar || "",
          pollData: m.pollData || null, checklistData: m.checklistData || null
        });
      });
      const merged = [...withoutId, ...Array.from(byId.values())].sort((a, b) => a.ts - b.ts);
      saveMessages(roomId, merged);

      // Если комнату/диалог открыли впервые на этом устройстве (например
      // по ID собеседника) и ни одного сообщения сами ещё не отправили —
      // локальной карточки в roomsLocal могло не быть вообще; заводим её
      // здесь тем же способом, что и при получении обычного "chat".
      ensureRoomsLoaded();
      if (merged.length && !roomsLocal.find((r) => r.id === roomId)) {
        const isDm = roomId.startsWith("dm-");
        const last = merged[merged.length - 1];
        const peerName = last.displayName || last.from;
        const entry = { id: roomId, title: isDm ? `Диалог с ${peerName}` : roomId };
        if (isDm) entry.peerLogin = peerName;
        roomsLocal.push(entry);
        saveRoomsForUser(roomsLocal);
      }

      renderRoomsList();
      if (roomId === currentRoom) {
        renderMessagesForCurrentRoom();
        updateChatHeader();
      }
      return;
    }

    if (msg.type === "system") {
      const m = {
        from: "Система",
        text: msg.text || "",
        ts: Date.now(),
        system: true
      };
      // не сохраняем системные в localStorage, просто рисуем если есть лог
      appendMessageToLog(m);
      return;
    }

    if (msg.type === "chat") {
      const me   = loadUser();
      const isMe = me && msg.from === me.login;
      const roomId = msg.room || "public";

      // сохраняем в историю
      const old = loadMessages(roomId);
      old.push({
        id: msg.id, from: msg.from, displayName: msg.fromDisplayName || msg.from, text: msg.text, ts: msg.ts,
        fileUrl: msg.fileUrl || null, fileName: msg.fileName || null, avatar: msg.avatar || "",
        pollData: msg.pollData || null, checklistData: msg.checklistData || null
      });
      saveMessages(roomId, old);

      // следим за списком комнат
      ensureRoomsLoaded();
      const existing = roomsLocal.find((r) => r.id === roomId);
      if (!existing) {
        const isDm = roomId.startsWith("dm-");
        const peerName = msg.fromDisplayName || msg.from;
        const entry = { id: roomId, title: isDm ? `Диалог с ${peerName}` : roomId };
        if (isDm) entry.peerLogin = peerName;
        roomsLocal.push(entry);
        saveRoomsForUser(roomsLocal);
      }
      // Обновляем превью последнего сообщения и время в списке диалогов —
      // не только для новых комнат, а на каждое сообщение (если мы сейчас
      // на странице чатов; на других страницах #roomList просто нет).
      renderRoomsList();

      // если открыта эта комната — рисуем
      if (roomId === currentRoom) {
        appendMessageToLog({
          id: msg.id,
          from: msg.from,
          displayName: msg.fromDisplayName,
          text: msg.text,
          ts: msg.ts,
          isMe,
          fileUrl: msg.fileUrl,
          fileName: msg.fileName,
          avatar: msg.avatar,
          pollData: msg.pollData,
          checklistData: msg.checklistData
        });
        if (!existing) updateChatHeader();
      }

      if (!isMe && !(getRoomById(roomId) && getRoomById(roomId).muted)) {
        tryShowNotification(msg.from, msg.text || (msg.fileUrl ? `📎 ${msg.fileName || "файл"}` : ""));
      }
    }
  });

  ws.addEventListener("close", () => {
    console.log(`WS closed, переподключение через ${WS_RECONNECT_DELAY / 1000}с`);
    setStatusOnline(false);
    wsReconnectTimer = setTimeout(() => {
      wsReconnectTimer = null;
      connectWebSocket();
    }, WS_RECONNECT_DELAY);
  });

  ws.addEventListener("error", (err) => {
    console.error("WS error:", err);
    setStatusOnline(false);
    // Дальше сработает "close" (так себя ведёт WebSocket) — переподключение
    // планируется там, дублировать здесь не нужно.
  });
}

async function sendChatMessage() {
  const ta = document.getElementById("text");
  if (!ta) return;
  const text = ta.value.trim();
  const fileInput = document.getElementById("file");
  const file = fileInput && fileInput.files && fileInput.files[0];
  if (!text && !file) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    alert("Нет подключения к чату");
    return;
  }
  const btnSend = document.getElementById("btnSend");
  if (btnSend) btnSend.disabled = true;
  try {
    let fileUrl = null;
    let fileName = null;
    if (file) {
      const form = new FormData();
      form.append("file", file);
      const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
      fileUrl = uploaded.url;
      fileName = uploaded.originalName;
    }
    ws.send(JSON.stringify({ type: "chat", room: currentRoom, text, fileUrl, fileName }));
    ta.value = "";
    if (fileInput) fileInput.value = "";
    const preview = document.getElementById("preview");
    if (preview) { preview.hidden = true; preview.innerHTML = ""; }
  } catch (err) {
    alert("Ошибка отправки файла: " + err.message);
  } finally {
    if (btnSend) btnSend.disabled = false;
  }
}

// ========================
// CHAT PAGE (chats.html)
// ========================

// Короткая метка времени для строки диалога — как в ВК: часы:минуты для
// сообщений за сегодня, иначе число и месяц (полная дата ни к чему в
// превью списка).
// Русское склонение по числу (1 минута / 2 минуты / 5 минут и т.д.) —
// используется и в "был(а) в сети N назад" (модалка "Информация о группе"),
// и в счётчиках медиа там же.
function pluralRu(n, one, few, many) {
  const mod10 = n % 10, mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

function formatLastSeen(ts) {
  if (!ts) return "давно не заходил(а)";
  const min = Math.floor((Date.now() - ts) / 60000);
  if (min < 1) return "был(а) только что";
  if (min < 60) return `был(а) ${min} ${pluralRu(min, "минуту", "минуты", "минут")} назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `был(а) ${hours} ${pluralRu(hours, "час", "часа", "часов")} назад`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `был(а) ${days} ${pluralRu(days, "день", "дня", "дней")} назад`;
  return `был(а) ${new Date(ts).toLocaleDateString("ru-RU", { day: "numeric", month: "short" })}`;
}

function formatRoomTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) {
    return d.toTimeString().slice(0, 5);
  }
  return d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
}

function renderRoomsList() {
  const roomList = document.getElementById("roomList");
  if (!roomList) return;
  ensureRoomsLoaded();
  const me = loadUser();

  roomList.innerHTML = "";
  roomsLocal.forEach((r) => {
    const msgs = loadMessages(r.id);
    const last = msgs.length ? msgs[msgs.length - 1] : null;

    const li = document.createElement("li");
    li.className = "room-item";
    if (r.id === currentRoom) li.classList.add("active");

    const avatar = document.createElement("div");
    avatar.className = "room-avatar";
    if (r.avatarUrl) {
      avatar.style.backgroundImage = `url("${r.avatarUrl}")`;
    } else {
      // Буква-заглушка — от того же значения, что и room-name ниже (иначе
      // у личного диалога без r.peerLogin в кэше выпадала бы буква "Д" от
      // "Диалог с ...", не имеющая отношения к собеседнику).
      const label = (r.id.startsWith("dm-") && r.peerLogin) ? r.peerLogin : r.title;
      avatar.textContent = (label || "?").trim()[0].toUpperCase();
    }

    const body = document.createElement("div");
    body.className = "room-body";
    const nameEl = document.createElement("div");
    nameEl.className = "room-name";
    // В личном диалоге — просто имя собеседника (peerLogin, как и в
    // шапке чата, см. updateChatHeader()), без префикса "Диалог с" из
    // r.title — тот используется только как fallback для старых записей
    // без peerLogin и как id-подобный заголовок у комнат.
    nameEl.textContent = (r.id.startsWith("dm-") && r.peerLogin) ? r.peerLogin : r.title;
    const previewEl = document.createElement("div");
    previewEl.className = "room-preview";
    if (last) {
      const mine = me && last.from === me.login;
      const text = last.text
        || (last.pollData ? `Опрос: ${last.pollData.question}` : "")
        || (last.checklistData ? `Список: ${last.checklistData.title}` : "")
        || (last.fileUrl ? "Вложение" : "");
      previewEl.textContent = (mine ? "Вы: " : "") + text;
    } else {
      previewEl.textContent = "Нет сообщений";
    }
    body.appendChild(nameEl);
    body.appendChild(previewEl);

    const timeEl = document.createElement("div");
    timeEl.className = "room-time";
    timeEl.textContent = last ? formatRoomTime(last.ts) : "";

    li.appendChild(avatar);
    li.appendChild(body);
    li.appendChild(timeEl);

    li.addEventListener("click", () => {
      switchRoom(r.id);
      const layout = document.querySelector(".chat-layout");
      if (layout) layout.classList.add("chat-open");
    });
    roomList.appendChild(li);
  });
}

// Переключает текущую комнату и по-настоящему переподключает WS с новым
// room в URL — простое присвоение currentRoom ничего не меняло: сервер
// привязывает комнату к соединению один раз при коннекте и игнорирует
// room, присланный в самих сообщениях, а connectWebSocket() не переоткрывает
// сокет, если он уже открыт.
function switchRoom(roomId) {
  if (currentRoom === roomId) return;
  currentRoom = roomId;
  // Статус собеседника/индикатор "печатает" — per-room: при переходе в
  // другой диалог старый статус (и, тем более, зависший таймер возврата
  // из "Печатает...") относится уже не к тому, кто открыт сейчас.
  dmPeerStatus = null;
  if (typingRevertTimer) { clearTimeout(typingRevertTimer); typingRevertTimer = null; }
  if (ws) {
    ws.close();
    ws = null;
  }
  renderRoomsList();
  renderMessagesForCurrentRoom();
  updateChatHeader();
  connectWebSocket();
}

function renderMessagesForCurrentRoom() {
  const logEl = document.getElementById("log");
  if (!logEl) return;
  logEl.innerHTML = "";

  const msgs = loadMessages(currentRoom);
  const me = loadUser();
  msgs.forEach((m) => {
    appendMessageToLog({
      id: m.id,
      from: m.from,
      displayName: m.displayName,
      text: m.text,
      ts: m.ts,
      isMe: me && m.from === me.login,
      fileUrl: m.fileUrl,
      fileName: m.fileName,
      avatar: m.avatar,
      pollData: m.pollData,
      checklistData: m.checklistData
    });
  });
}

function initTextareaAutoGrow() {
  const ta = document.getElementById("text");
  if (!ta) return;
  const maxHeight = 120;
  const resize = () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, maxHeight) + "px";
  };
  ta.addEventListener("input", resize);
  resize();
}

function initChatPage() {
  const user = loadUser();
  if (!user) {
    window.location.href = "auth.html";
    return;
  }

  initCommonNav();
  initThemeToggle();
  startChecklistTicker();

  const btnSend         = document.getElementById("btnSend");
  const textarea        = document.getElementById("text");
  const btnFile         = document.getElementById("btnFile");
  const fileInput       = document.getElementById("file");
  const preview         = document.getElementById("preview");
  const userSearchInput = document.getElementById("userSearchInput");
  const userSearchBtn   = document.getElementById("userSearchBtn");
  const userSearchResults = document.getElementById("userSearchResults");
  const btnAddRoom      = document.getElementById("btnAddRoom");
  const addRoomForm     = document.getElementById("addRoomForm");
  const newRoomName     = document.getElementById("newRoomName");
  const newRoomConfirmBtn = document.getElementById("newRoomConfirmBtn");
  const chatBackBtn     = document.getElementById("chatBackBtn");
  const chatLayoutEl    = document.querySelector(".chat-layout");
  const chatMenuBtn     = document.getElementById("chatMenuBtn");
  const chatMenuDropdown = document.getElementById("chatMenuDropdown");
  const wallpaperForm      = document.getElementById("wallpaperForm");
  const wallpaperUrlInput  = document.getElementById("wallpaperUrlInput");
  const wallpaperApplyBtn  = document.getElementById("wallpaperApplyBtn");

  if (btnFile) btnFile.innerHTML = icon("clip", 17);
  if (btnSend) btnSend.innerHTML = icon("send", 17);
  if (btnAddRoom) btnAddRoom.innerHTML = icon("plus", 14) + " Комната";
  if (chatBackBtn) chatBackBtn.innerHTML = icon("chevronLeft", 20);
  if (chatMenuBtn) chatMenuBtn.innerHTML = icon("moreVertical", 18);

  // Кнопка звонка — только для личных диалогов (видимость переключается
  // в updateChatHeader() на каждую смену чата), звонки по комнатам/группам
  // не делаем (это уже был бы групповой звонок — отдельная фича).
  const chatCallBtn = document.getElementById("chatCallBtn");
  if (chatCallBtn) {
    chatCallBtn.innerHTML = icon("call", 18);
    chatCallBtn.addEventListener("click", () => {
      const peerId = getDmPeerId(currentRoom);
      if (!peerId) return;
      apiRequest(`/api/user-by-id/${encodeURIComponent(peerId)}`)
        .then((peer) => startCall(peer.login, peer.displayName || peer.login, peer.avatarUrl))
        .catch((err) => alert("Не удалось начать звонок: " + err.message));
    });
  }

  // На мобильном список диалогов и сам чат — как два отдельных "экрана"
  // (по образцу ВК): по умолчанию виден список, выбор диалога открывает
  // чат на весь экран, кнопка-стрелка возвращает обратно к списку. На
  // десктопе класс ничего не меняет — там оба блока видны всегда рядом
  // (см. styles.css, .chat-layout вне мобильного @media).
  if (chatBackBtn && chatLayoutEl) {
    chatBackBtn.addEventListener("click", () => {
      chatLayoutEl.classList.remove("chat-open");
    });
  }

  // Аватар в шапке чата кликабельный — как в телеграме: если у чата есть
  // фото, клик открывает его на весь экран (openPhotoLightbox(), тот же
  // лайтбокс, что и на странице профиля) — переход в профиль/"Информация
  // о группе" и так уже доступны через пункты меню "Показать профиль"/
  // "Информация о группе", а показать саму картинку целиком им нечем.
  // Если фото нет (аватар — просто буква-заглушка), смотреть нечего —
  // тогда старое поведение: переход на профиль собеседника (личный
  // диалог) или открытие "Информация о группе" (комната). Слушатель один
  // на всю страницу (а не перевешивается в updateChatHeader() на каждую
  // смену чата) — currentRoom/room читаются прямо в моменте клика,
  // поэтому всегда актуальны.
  const chatHeaderAvatarEl = document.getElementById("chatHeaderAvatar");
  if (chatHeaderAvatarEl) {
    chatHeaderAvatarEl.addEventListener("click", () => {
      const room = getRoomById(currentRoom);
      if (room && room.avatarUrl) {
        openPhotoLightbox(room.avatarUrl);
        return;
      }
      if (currentRoom.startsWith("dm-")) {
        const peerId = getDmPeerId(currentRoom);
        if (peerId) window.location.href = `profile.html?id=${encodeURIComponent(peerId)}`;
      } else {
        showGroupInfoModal();
      }
    });
  }

  // Имя в шапке чата кликабельное — как в телеграме: открывает визитку
  // собеседника прямо поверх чата (openChatPeerCard()), не уводя со
  // страницы. Для комнаты/группы имени как отдельной сущности нет —
  // просто открывает ту же "Информацию о группе", что и в меню.
  const chatHeaderTitleEl = document.getElementById("chatHeaderTitle");
  if (chatHeaderTitleEl) {
    chatHeaderTitleEl.addEventListener("click", () => openChatPeerCard());
  }

  // Загрузка файла для аватара комнаты в "Управление группой" — загружает
  // через общий /api/upload, кладёт полученную ссылку в текстовое поле
  // (сохранение по-прежнему через кнопку "Сохранить" в saveGroupManage()).
  const manageRoomUploadBtn = document.getElementById("manageRoomUploadBtn");
  const manageRoomFileInput = document.getElementById("manageRoomFileInput");
  if (manageRoomUploadBtn && manageRoomFileInput) {
    manageRoomUploadBtn.addEventListener("click", () => manageRoomFileInput.click());
    manageRoomFileInput.addEventListener("change", async () => {
      const file = manageRoomFileInput.files && manageRoomFileInput.files[0];
      if (!file) return;
      manageRoomUploadBtn.disabled = true;
      try {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
        const avatarInput = document.getElementById("manageRoomAvatar");
        if (avatarInput) avatarInput.value = uploaded.url;
        updateManageRoomAvatarPreview();
      } catch (err) {
        alert("Ошибка загрузки фото: " + err.message);
      } finally {
        manageRoomFileInput.value = "";
        manageRoomUploadBtn.disabled = false;
      }
    });
  }

  // Меню "три точки" в шапке чата (по образцу телеграма) — набор пунктов
  // собирается динамически под текущую комнату в renderChatMenu()
  // (зовётся из updateChatHeader() при каждой смене чата), потому что
  // список отличается для группы/комнаты и для личного диалога.
  if (chatMenuBtn && chatMenuDropdown) {
    chatMenuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      chatMenuDropdown.hidden = !chatMenuDropdown.hidden;
    });
    chatMenuDropdown.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => { chatMenuDropdown.hidden = true; });
  }

  if (wallpaperApplyBtn && wallpaperUrlInput && wallpaperForm) {
    wallpaperApplyBtn.addEventListener("click", () => {
      const url = wallpaperUrlInput.value.trim();
      saveRoomMeta(currentRoom, { wallpaperUrl: url });
      applyWallpaper();
      renderChatMenu();
      wallpaperForm.hidden = true;
    });
  }

  const manageRoomSaveBtn = document.getElementById("manageRoomSaveBtn");
  if (manageRoomSaveBtn) manageRoomSaveBtn.addEventListener("click", saveGroupManage);

  const pollAddOptionBtn = document.getElementById("pollAddOptionBtn");
  if (pollAddOptionBtn) pollAddOptionBtn.addEventListener("click", addPollOptionInput);

  const pollCreateBtn = document.getElementById("pollCreateBtn");
  if (pollCreateBtn) pollCreateBtn.addEventListener("click", createPollFromForm);

  const reportSendBtn = document.getElementById("reportSendBtn");
  if (reportSendBtn) reportSendBtn.addEventListener("click", sendReportFromForm);

  const checklistAddItemBtn = document.getElementById("checklistAddItemBtn");
  if (checklistAddItemBtn) checklistAddItemBtn.addEventListener("click", addChecklistItemInput);

  const checklistCreateBtn = document.getElementById("checklistCreateBtn");
  if (checklistCreateBtn) checklistCreateBtn.addEventListener("click", createChecklistFromForm);

  ensureRoomsLoaded();
  renderRoomsList();
  renderMessagesForCurrentRoom();
  updateChatHeader();
  connectWebSocket();

  if (btnSend) {
    btnSend.addEventListener("click", () => sendChatMessage());
  }

  if (textarea) {
    textarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        sendChatMessage();
      }
    });

    // "Печатает..." — только для личных диалогов (см. просьбу пользователя),
    // в комнатах/группах индикатора нет. Троттлинг раз в ~2с — "input"
    // стреляет на каждый символ, слать WS-сообщение на каждый было бы
    // избыточно, собеседнику достаточно знать "печатает прямо сейчас",
    // не точное число нажатий.
    let lastTypingSentAt = 0;
    textarea.addEventListener("input", () => {
      if (!currentRoom.startsWith("dm-")) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const now = Date.now();
      if (now - lastTypingSentAt < 2000) return;
      lastTypingSentAt = now;
      ws.send(JSON.stringify({ type: "typing", room: currentRoom }));
    });
  }

  initTextareaAutoGrow();

  if (btnFile && fileInput && preview) {
    btnFile.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files && fileInput.files[0];
      preview.innerHTML = "";
      if (!file) {
        preview.hidden = true;
        return;
      }
      preview.hidden = false;
      if (isImageFileName(file.name)) {
        const img = document.createElement("img");
        img.className = "thumb-img";
        img.src = URL.createObjectURL(file);
        preview.appendChild(img);
      } else {
        const thumb = document.createElement("div");
        thumb.className = "thumb";
        thumb.innerHTML = icon("clip", 14);
        thumb.appendChild(document.createTextNode(" " + file.name));
        preview.appendChild(thumb);
      }
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "thumb-clear";
      clearBtn.innerHTML = icon("close", 12);
      clearBtn.addEventListener("click", () => {
        fileInput.value = "";
        preview.innerHTML = "";
        preview.hidden = true;
      });
      preview.appendChild(clearBtn);
    });
  }

  // Раньше здесь был prompt() — нативный блокирующий диалог, который в
  // части браузеров/окружений вообще не показывается (тихо возвращает
  // null), из-за чего кнопка выглядела нерабочей. Обычная встроенная
  // форма, как и везде в проекте (создание группы/альбома и т.д.).
  function createRoomFromInput() {
    if (!newRoomName) return;
    const name = newRoomName.value.trim();
    if (!name) return;
    const id = "room-" + name.toLowerCase().replace(/\s+/g, "-") + "-" + Date.now();
    roomsLocal.push({ id, title: name });
    saveRoomsForUser(roomsLocal);
    newRoomName.value = "";
    if (addRoomForm) addRoomForm.hidden = true;
    switchRoom(id);
    // Регистрируем карточку комнаты на сервере (имя+владелец) — без этого
    // "Информация о группе"/"Управление группой" не будут работать ни у
    // кого, кто зайдёт в эту комнату. Best-effort: если не получилось —
    // комната всё равно создана и работает как обычный WS-канал, просто
    // без этих двух пунктов меню.
    apiRequest("/api/chat-rooms", { method: "POST", body: { id, name } }).catch(() => {});
    if (window.matchMedia("(max-width: 768px)").matches && chatLayoutEl) {
      chatLayoutEl.classList.add("chat-open");
    }
  }

  if (btnAddRoom && addRoomForm) {
    btnAddRoom.addEventListener("click", () => {
      addRoomForm.hidden = !addRoomForm.hidden;
      if (!addRoomForm.hidden && newRoomName) newRoomName.focus();
    });
  }

  if (newRoomConfirmBtn) newRoomConfirmBtn.addEventListener("click", createRoomFromInput);
  if (newRoomName) {
    newRoomName.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createRoomFromInput(); }
    });
  }

  // Поиск собеседника — сначала пробуем как точный ID (быстрый путь, как
  // раньше), и только если это не сработало — как имя/логин через
  // /api/users?q= (тот же поиск, что и на friends.html), с выбором из
  // списка результатов: по имени совпадений может быть несколько, в
  // отличие от ID, который всегда указывает на одного конкретного
  // человека однозначно.
  async function runUserSearch() {
    const query = userSearchInput.value.trim();
    if (!query) return;
    if (userSearchResults) { userSearchResults.innerHTML = ""; userSearchResults.hidden = true; }
    try {
      await openDmWithUserId(query);
      return;
    } catch (err) {
      // не нашлось по ID — пробуем как имя ниже
    }
    try {
      const users = await apiRequest(`/api/users?q=${encodeURIComponent(query)}`);
      if (!userSearchResults) return;
      if (!users.length) {
        userSearchResults.innerHTML = `<p class="muted">Никого не нашлось.</p>`;
        userSearchResults.hidden = false;
        return;
      }
      userSearchResults.innerHTML = "";
      users.forEach((u) => {
        const row = renderPersonRow(u, {});
        row.querySelectorAll(".btn").forEach((b) => b.remove()); // без лишних "Написать"/"Действие" — сама строка кликабельна
        row.querySelector(".person-link").addEventListener("click", (e) => {
          e.preventDefault();
          userSearchResults.hidden = true;
          userSearchResults.innerHTML = "";
          userSearchInput.value = "";
          openDmWithUserId(u.id).catch((err) => alert("Не удалось открыть диалог: " + err.message));
        });
        userSearchResults.appendChild(row);
      });
      userSearchResults.hidden = false;
    } catch (err) {
      alert("Пользователь не найден: " + err.message);
    }
  }

  if (userSearchBtn && userSearchInput) {
    userSearchBtn.addEventListener("click", runUserSearch);
    userSearchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runUserSearch(); }
    });
  }

  // Переход "Написать сообщение" с чужого профиля (profile.html) приходит
  // сюда как chats.html?peer=<userId> — открываем/заводим тот же dm-<a>-<b>,
  // что и поиск по ID выше (это тот же код, см. openDmWithUserId()).
  const peerParam = new URLSearchParams(window.location.search).get("peer");
  if (peerParam) {
    openDmWithUserId(peerParam).catch((err) => {
      console.error(err);
      alert("Не удалось открыть диалог: " + err.message);
    });
  }
}

// Открывает (или заводит локальную карточку и открывает) личный диалог с
// пользователем по его ID — общий код для поиска по ID в чатах и для
// перехода "Написать сообщение" с профиля/визитки (chats.html?peer=<id>).
async function openDmWithUserId(userId) {
  const data = await apiRequest(`/api/user-by-id/${encodeURIComponent(userId)}`, { method: "GET" });

  const me = loadUser();
  if (!me || !me.id || !data.id) return;
  const a = me.id;
  const b = data.id;
  const roomId = a < b ? `dm-${a}-${b}` : `dm-${b}-${a}`;

  const peerName = data.displayName || data.login;
  ensureRoomsLoaded();
  const already = roomsLocal.find((r) => r.id === roomId);
  if (already) {
    already.peerLogin = peerName;
    already.title = `Диалог с ${peerName}`;
    already.avatarUrl = data.avatarUrl || "";
  } else {
    roomsLocal.push({
      id: roomId,
      title: `Диалог с ${peerName}`,
      peerLogin: peerName,
      avatarUrl: data.avatarUrl || ""
    });
  }
  saveRoomsForUser(roomsLocal);
  renderRoomsList();
  if (roomId === currentRoom) updateChatHeader();

  switchRoom(roomId);
  const chatLayoutEl = document.querySelector(".chat-layout");
  if (window.matchMedia("(max-width: 768px)").matches && chatLayoutEl) {
    chatLayoutEl.classList.add("chat-open");
  }
}

// ========================
// СТЕНА (посты, лайки, комментарии) — index.html / profile.html / group.html
// ========================

function formatWallDate(ts) {
  return new Date(ts).toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit"
  });
}

function renderCommentRow(c) {
  const row = document.createElement("div");
  row.className = "comment-row";
  // В комментариях порядок обратный посту: сначала текст, фото (если есть) — под ним.
  row.innerHTML = `
    <a class="comment-author"></a><span class="comment-text"></span>
    <img class="comment-photo" hidden>
  `;
  const a = row.querySelector(".comment-author");
  a.href = `profile.html?id=${encodeURIComponent(c.authorId)}`;
  a.textContent = c.authorName;
  row.querySelector(".comment-text").textContent = c.text;
  if (c.photoUrl) {
    const photo = row.querySelector(".comment-photo");
    photo.src = c.photoUrl;
    photo.hidden = false;
  }
  return row;
}

function renderPostCard(post) {
  const card = document.createElement("div");
  card.className = "post-card";
  card.innerHTML = `
    <div class="post-header">
      <a class="post-author"></a>
      <span class="post-date"></span>
    </div>
    <div class="post-context" hidden></div>
    <div class="moderation-reason" hidden></div>
    <img class="post-photo" hidden>
    <div class="post-text"></div>
    <div class="post-actions">
      <button class="post-like-btn btn">${icon("like", 16)} <span class="like-count"></span></button>
      <button class="post-comment-toggle btn">${icon("comment", 16)} <span class="comment-count"></span></button>
    </div>
    <div class="post-comments" hidden>
      <div class="comments-list"></div>
      <div class="comment-photo-preview" hidden></div>
      <div class="comment-form">
        <button type="button" class="btn-attach comment-attach-btn" title="Прикрепить фото">${icon("camera", 15)}</button>
        <input type="file" accept="image/*" class="comment-file-input" hidden>
        <input class="comment-input" placeholder="Написать комментарий...">
        <button class="btn comment-send">Отправить</button>
      </div>
    </div>
  `;

  const authorLink = card.querySelector(".post-author");
  authorLink.href = `profile.html?id=${encodeURIComponent(post.authorId)}`;
  authorLink.textContent = post.authorName;

  if (post.contextLabel) {
    const contextEl = card.querySelector(".post-context");
    contextEl.hidden = false;
    const link = document.createElement("a");
    link.href = post.ownerType === "group"
      ? `group.html?id=${encodeURIComponent(post.ownerId)}`
      : `profile.html?id=${encodeURIComponent(post.ownerId)}`;
    link.textContent = post.contextLabel;
    contextEl.appendChild(document.createTextNode(post.ownerType === "group" ? "в группе " : "на стене "));
    contextEl.appendChild(link);
  }
  card.querySelector(".post-date").textContent = formatWallDate(post.createdAt);
  if (post.moderationStatus === "flagged") {
    const reasonEl = card.querySelector(".moderation-reason");
    reasonEl.hidden = false;
    reasonEl.textContent = "На проверке у модератора" + (post.moderationReason ? ": " + post.moderationReason : "");
  }
  card.querySelector(".post-text").textContent = post.text;
  if (post.photoUrl) {
    const photo = card.querySelector(".post-photo");
    photo.src = post.photoUrl;
    photo.hidden = false;
  }
  card.querySelector(".like-count").textContent = post.likesCount;
  card.querySelector(".comment-count").textContent = post.commentsCount;

  const likeBtn = card.querySelector(".post-like-btn");
  likeBtn.classList.toggle("active", post.likedByMe);
  likeBtn.addEventListener("click", async () => {
    try {
      const res = await apiRequest(`/api/posts/${post.id}/like`, { method: "POST" });
      likeBtn.classList.toggle("active", res.likedByMe);
      card.querySelector(".like-count").textContent = res.likesCount;
    } catch (err) { alert("Ошибка: " + err.message); }
  });

  const commentToggle = card.querySelector(".post-comment-toggle");
  const commentsBox = card.querySelector(".post-comments");
  const commentsList = card.querySelector(".comments-list");
  let commentsLoaded = false;
  commentToggle.addEventListener("click", async () => {
    commentsBox.hidden = !commentsBox.hidden;
    if (!commentsBox.hidden && !commentsLoaded) {
      commentsLoaded = true;
      try {
        const comments = await apiRequest(`/api/posts/${post.id}/comments`);
        commentsList.innerHTML = "";
        comments.forEach(c => commentsList.appendChild(renderCommentRow(c)));
      } catch (err) {
        commentsList.textContent = "Ошибка: " + err.message;
      }
    }
  });

  const sendBtn = card.querySelector(".comment-send");
  const input = card.querySelector(".comment-input");
  const commentAttachBtn = card.querySelector(".comment-attach-btn");
  const commentFileInput = card.querySelector(".comment-file-input");
  const commentPreview = card.querySelector(".comment-photo-preview");

  function clearCommentPhoto() {
    commentFileInput.value = "";
    commentPreview.hidden = true;
    commentPreview.innerHTML = "";
  }

  commentAttachBtn.addEventListener("click", () => commentFileInput.click());
  commentFileInput.addEventListener("change", () => {
    const file = commentFileInput.files && commentFileInput.files[0];
    commentPreview.innerHTML = "";
    if (!file) { commentPreview.hidden = true; return; }
    commentPreview.hidden = false;
    const img = document.createElement("img");
    img.src = URL.createObjectURL(file);
    commentPreview.appendChild(img);
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "wall-composer-preview-clear";
    clearBtn.innerHTML = icon("close", 13);
    clearBtn.addEventListener("click", clearCommentPhoto);
    commentPreview.appendChild(clearBtn);
  });

  const sendComment = async () => {
    const text = input.value.trim();
    const file = commentFileInput.files && commentFileInput.files[0];
    if (!text && !file) return;
    sendBtn.disabled = true;
    try {
      let photoUrl = null;
      if (file) {
        const form = new FormData();
        form.append("file", file);
        const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
        photoUrl = uploaded.url;
      }
      const c = await apiRequest(`/api/posts/${post.id}/comments`, { method: "POST", body: { text, photoUrl } });
      commentsList.appendChild(renderCommentRow(c));
      input.value = "";
      clearCommentPhoto();
      const countEl = card.querySelector(".comment-count");
      countEl.textContent = (parseInt(countEl.textContent, 10) || 0) + 1;
    } catch (err) { alert("Ошибка: " + err.message); }
    finally { sendBtn.disabled = false; }
  };
  sendBtn.addEventListener("click", sendComment);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); sendComment(); }
  });

  return card;
}

// Рендерит стену (композер + список постов) в контейнер containerId.
// ownerType/ownerId — чья это стена ('user'|'group'); canPost — можно ли
// писать на эту стену (себе — да, чужому профилю — нет, группе — если участник).
function initWall(containerId, ownerType, ownerId, canPost) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    ${canPost ? `
      <div class="wall-composer">
        <textarea id="wallPostText" rows="2" placeholder="Что нового?"></textarea>
        <div class="wall-composer-preview" id="wallPhotoPreview" hidden></div>
        <div class="wall-composer-actions">
          <button type="button" id="wallPhotoBtn" class="btn-attach" title="Добавить фото">${icon("camera", 16)}</button>
          <input type="file" id="wallPhotoInput" accept="image/*" hidden>
          <button id="wallPostBtn" class="btn primary">Опубликовать</button>
        </div>
      </div>
    ` : ""}
    <div class="wall-posts"></div>
  `;

  const postsEl = container.querySelector(".wall-posts");

  async function loadWallPosts() {
    postsEl.innerHTML = "";
    const loading = document.createElement("p");
    loading.className = "muted";
    loading.textContent = "Загрузка...";
    postsEl.appendChild(loading);
    try {
      const posts = await apiRequest(`/api/posts?ownerType=${encodeURIComponent(ownerType)}&ownerId=${encodeURIComponent(ownerId)}`);
      postsEl.innerHTML = "";
      if (!posts.length) {
        const empty = document.createElement("p");
        empty.className = "muted";
        empty.textContent = "На стене пока пусто.";
        postsEl.appendChild(empty);
        return;
      }
      posts.forEach(p => postsEl.appendChild(renderPostCard(p)));
    } catch (err) {
      postsEl.textContent = "Ошибка загрузки: " + err.message;
    }
  }

  if (canPost) {
    const btn = document.getElementById("wallPostBtn");
    const ta = document.getElementById("wallPostText");
    const photoBtn = document.getElementById("wallPhotoBtn");
    const photoInput = document.getElementById("wallPhotoInput");
    const preview = document.getElementById("wallPhotoPreview");

    function clearPhotoPick() {
      photoInput.value = "";
      preview.hidden = true;
      preview.innerHTML = "";
    }

    photoBtn.addEventListener("click", () => photoInput.click());
    photoInput.addEventListener("change", () => {
      const file = photoInput.files && photoInput.files[0];
      if (!file) { clearPhotoPick(); return; }
      preview.innerHTML = "";
      preview.hidden = false;
      const img = document.createElement("img");
      img.src = URL.createObjectURL(file);
      preview.appendChild(img);
      const clearBtn = document.createElement("button");
      clearBtn.type = "button";
      clearBtn.className = "wall-composer-preview-clear";
      clearBtn.innerHTML = icon("close", 13);
      clearBtn.addEventListener("click", clearPhotoPick);
      preview.appendChild(clearBtn);
    });

    btn.addEventListener("click", async () => {
      const text = ta.value.trim();
      const file = photoInput.files && photoInput.files[0];
      if (!text && !file) return;
      btn.disabled = true;
      try {
        let photoUrl = null;
        if (file) {
          const form = new FormData();
          form.append("file", file);
          const uploaded = await apiRequest("/api/upload", { method: "POST", body: form });
          photoUrl = uploaded.url;
        }
        await apiRequest("/api/posts", { method: "POST", body: { ownerType, ownerId, text, photoUrl } });
        ta.value = "";
        clearPhotoPick();
        loadWallPosts();
      } catch (err) {
        alert("Ошибка публикации: " + err.message);
      } finally {
        btn.disabled = false;
      }
    });
  }

  loadWallPosts();
}

// ========================
// ДРУЗЬЯ (friends.html) / ПРОФИЛЬ (profile.html)
// ========================

const FRIEND_STATUS_LABELS = {
  none: "Добавить в друзья",
  outgoing: "Заявка отправлена — отменить",
  incoming: "Принять заявку",
  friends: "Удалить из друзей"
};

function renderPersonRow(user, { onAction, actionLabel } = {}) {
  const row = document.createElement("div");
  row.className = "person-row";
  row.innerHTML = `
    <a class="person-link">
      <span class="person-avatar"></span>
      <span class="person-login"></span>
    </a>
  `;
  const displayName = user.displayName || user.login;
  const link = row.querySelector(".person-link");
  link.href = `profile.html?id=${encodeURIComponent(user.id)}`;
  row.querySelector(".person-login").textContent = displayName;
  const avatarEl = row.querySelector(".person-avatar");
  if (user.avatarUrl) {
    avatarEl.style.backgroundImage = `url("${user.avatarUrl}")`;
  } else {
    avatarEl.textContent = (displayName || "?")[0].toUpperCase();
  }
  // "Написать" — есть у любой строки другого пользователя (друзья, заявки,
  // подписки, результаты поиска), а не только на самой странице профиля —
  // так со списка можно сразу перейти в личку, не заходя лишний раз в
  // профиль. openDmWithUserId() определена в разделе чатов ниже по файлу.
  const me = loadUser();
  if (!me || me.id !== user.id) {
    const messageBtn = document.createElement("a");
    messageBtn.className = "btn";
    messageBtn.href = `chats.html?peer=${encodeURIComponent(user.id)}`;
    messageBtn.textContent = "Написать";
    row.appendChild(messageBtn);
  }
  if (onAction) {
    const btn = document.createElement("button");
    btn.className = "btn";
    btn.textContent = actionLabel || "Действие";
    btn.addEventListener("click", () => onAction(btn, row));
    row.appendChild(btn);
  }
  return row;
}

async function initProfilePage() {
  const me = loadUser();
  initCommonNav();
  initThemeToggle();

  const targetId = new URLSearchParams(window.location.search).get("id");
  const nameEl = document.getElementById("profileViewName");
  const avatarEl = document.getElementById("profileViewAvatar");
  const idEl = document.getElementById("profileViewId");
  const aboutLabelEl = document.getElementById("profileViewAboutLabel");
  const aboutEl = document.getElementById("profileViewAbout");
  const friendBtnWrap = document.getElementById("profileFriendAction");

  if (!targetId) {
    if (nameEl) nameEl.textContent = "Не указан ID пользователя";
    return;
  }

  let target;
  try {
    target = await apiRequest(`/api/user-by-id/${encodeURIComponent(targetId)}`);
  } catch (err) {
    if (nameEl) nameEl.textContent = "Пользователь не найден";
    return;
  }

  if (nameEl) nameEl.textContent = target.displayName || target.login;
  const loginEl = document.getElementById("profileViewLogin");
  if (loginEl) loginEl.textContent = target.login;
  if (idEl) idEl.textContent = target.id;
  if (target.about && aboutEl && aboutLabelEl) {
    aboutEl.textContent = target.about;
    aboutEl.hidden = false;
    aboutLabelEl.hidden = false;
  }
  if (avatarEl) {
    if (target.avatarUrl) {
      avatarEl.src = target.avatarUrl;
      avatarEl.style.display = "block";
      avatarEl.addEventListener("click", () => openPhotoLightbox(target.avatarUrl));
    } else {
      avatarEl.style.display = "none";
    }
  }

  async function renderFriendAction() {
    if (!friendBtnWrap) return;
    friendBtnWrap.innerHTML = "";
    if (targetId === me.id) return;

    // Раньше с профиля вообще не было способа начать личный диалог —
    // единственный путь был вручную вбить ID собеседника в поиск на
    // chats.html, о котором большинство не знало и просто писало в
    // открытый по умолчанию "Общий чат", думая, что это переписка
    // один на один. Кнопка ведёт на chats.html?peer=<id> —
    // openDmWithUserId() там заводит (или открывает уже существующий)
    // dm-<a>-<b> и сразу переключается в него.
    const messageBtn = document.createElement("a");
    messageBtn.className = "btn primary";
    messageBtn.href = `chats.html?peer=${encodeURIComponent(targetId)}`;
    messageBtn.textContent = "Написать сообщение";
    friendBtnWrap.appendChild(messageBtn);

    let status;
    try {
      status = (await apiRequest(`/api/friends/status/${encodeURIComponent(targetId)}`)).status;
    } catch (err) { return; }

    if (status === "incoming") {
      const acceptBtn = document.createElement("button");
      acceptBtn.className = "btn primary";
      acceptBtn.textContent = "Принять заявку";
      acceptBtn.addEventListener("click", async () => {
        await apiRequest(`/api/friends/accept/${encodeURIComponent(targetId)}`, { method: "POST" });
        renderFriendAction();
      });
      const declineBtn = document.createElement("button");
      declineBtn.className = "btn";
      declineBtn.textContent = "Отклонить";
      declineBtn.addEventListener("click", async () => {
        await apiRequest(`/api/friends/decline/${encodeURIComponent(targetId)}`, { method: "POST" });
        renderFriendAction();
      });
      friendBtnWrap.appendChild(acceptBtn);
      friendBtnWrap.appendChild(declineBtn);
      return;
    }

    const btn = document.createElement("button");
    btn.className = "btn" + (status === "none" ? " primary" : "");
    btn.textContent = FRIEND_STATUS_LABELS[status] || "…";
    btn.addEventListener("click", async () => {
      try {
        if (status === "none") await apiRequest(`/api/friends/request/${encodeURIComponent(targetId)}`, { method: "POST" });
        else await apiRequest(`/api/friends/decline/${encodeURIComponent(targetId)}`, { method: "POST" });
        renderFriendAction();
      } catch (err) { alert("Ошибка: " + err.message); }
    });
    friendBtnWrap.appendChild(btn);
  }
  renderFriendAction();

  initWall("wallSection", "user", targetId, false);
}

async function initFriendsPage() {
  initCommonNav();
  initThemeToggle();

  const friendsListEl = document.getElementById("friendsList");
  const requestsListEl = document.getElementById("friendsRequestsList");
  const subsListEl = document.getElementById("friendsSubsList");
  const searchInput = document.getElementById("friendSearchInput");
  const searchBtn = document.getElementById("friendSearchBtn");
  const searchResultsEl = document.getElementById("friendSearchResults");

  // Вкладки: Друзья / Заявки (входящие) / Подписки (мои исходящие заявки —
  // семантически "я подписан на них, но не факт, что они на меня").
  const tabsEl = document.getElementById("friendsTabs");
  const TAB_PANELS = { friends: friendsListEl, requests: requestsListEl, subscriptions: subsListEl };
  if (tabsEl) {
    tabsEl.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        tabsEl.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b === btn));
        Object.entries(TAB_PANELS).forEach(([key, el]) => {
          if (el) el.hidden = key !== btn.dataset.tab;
        });
      });
    });
  }

  async function renderFriends() {
    if (!friendsListEl) return;
    friendsListEl.innerHTML = "";
    try {
      const friends = await apiRequest("/api/friends");
      if (!friends.length) {
        friendsListEl.innerHTML = `<p class="muted">Пока нет друзей.</p>`;
      } else {
        friends.forEach(f => friendsListEl.appendChild(renderPersonRow(f, {
          actionLabel: "Удалить",
          onAction: async () => {
            await apiRequest(`/api/friends/decline/${encodeURIComponent(f.id)}`, { method: "POST" });
            renderFriends();
          }
        })));
      }
    } catch (err) { friendsListEl.textContent = "Ошибка: " + err.message; }
  }

  async function renderRequests() {
    if (!requestsListEl) return;
    requestsListEl.innerHTML = "";
    try {
      const requests = await apiRequest("/api/friends/requests");
      if (!requests.length) {
        requestsListEl.innerHTML = `<p class="muted">Нет входящих заявок.</p>`;
      } else {
        requests.forEach(r => {
          const row = renderPersonRow(r, {
            actionLabel: "Принять",
            onAction: async () => {
              await apiRequest(`/api/friends/accept/${encodeURIComponent(r.id)}`, { method: "POST" });
              renderRequests();
              renderFriends();
            }
          });
          const declineBtn = document.createElement("button");
          declineBtn.className = "btn";
          declineBtn.textContent = "Отклонить";
          declineBtn.addEventListener("click", async () => {
            await apiRequest(`/api/friends/decline/${encodeURIComponent(r.id)}`, { method: "POST" });
            renderRequests();
          });
          row.appendChild(declineBtn);
          requestsListEl.appendChild(row);
        });
      }
    } catch (err) { requestsListEl.textContent = "Ошибка: " + err.message; }
  }

  async function renderSubscriptions() {
    if (!subsListEl) return;
    subsListEl.innerHTML = "";
    try {
      const subs = await apiRequest("/api/friends/subscriptions");
      if (!subs.length) {
        subsListEl.innerHTML = `<p class="muted">Нет подписок — вы ни на кого не подали заявку в друзья.</p>`;
      } else {
        subs.forEach(s => subsListEl.appendChild(renderPersonRow(s, {
          actionLabel: "Отписаться",
          onAction: async () => {
            await apiRequest(`/api/friends/decline/${encodeURIComponent(s.id)}`, { method: "POST" });
            renderSubscriptions();
          }
        })));
      }
    } catch (err) { subsListEl.textContent = "Ошибка: " + err.message; }
  }

  async function runSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    try {
      const users = await apiRequest(`/api/users?q=${encodeURIComponent(q)}`);
      searchResultsEl.innerHTML = "";
      if (!users.length) {
        searchResultsEl.innerHTML = `<p class="muted">Никого не нашлось.</p>`;
      } else {
        users.forEach(u => searchResultsEl.appendChild(renderPersonRow(u, {
          actionLabel: "Добавить в друзья",
          onAction: async (btn) => {
            try {
              await apiRequest(`/api/friends/request/${encodeURIComponent(u.id)}`, { method: "POST" });
              btn.textContent = "Заявка отправлена";
              btn.disabled = true;
              renderSubscriptions();
            } catch (err) { alert("Ошибка: " + err.message); }
          }
        })));
      }
    } catch (err) { alert("Ошибка поиска: " + err.message); }
  }

  if (searchBtn && searchInput) {
    searchBtn.addEventListener("click", runSearch);
    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); runSearch(); }
    });
  }

  renderFriends();
  renderRequests();
  renderSubscriptions();
}

// ========================
// ГРУППЫ (groups.html / group.html)
// ========================

function renderGroupCard(group) {
  const card = document.createElement("div");
  card.className = "group-card";
  card.innerHTML = `
    <a class="group-name"></a>
    <p class="group-description"></p>
    <p class="muted group-members-count"></p>
  `;
  const link = card.querySelector(".group-name");
  link.href = `group.html?id=${encodeURIComponent(group.id)}`;
  link.textContent = group.name;
  card.querySelector(".group-description").textContent = group.description || "";
  card.querySelector(".group-members-count").textContent = `Участников: ${group.membersCount}`;
  return card;
}

async function initGroupsPage() {
  initCommonNav();
  initThemeToggle();

  const listEl = document.getElementById("groupsList");
  const nameInput = document.getElementById("groupNameInput");
  const descInput = document.getElementById("groupDescInput");
  const createBtn = document.getElementById("groupCreateBtn");

  async function renderGroups() {
    if (!listEl) return;
    listEl.innerHTML = "";
    try {
      const groups = await apiRequest("/api/groups");
      if (!groups.length) {
        listEl.innerHTML = `<p class="muted">Пока нет ни одной группы. Создайте первую!</p>`;
      } else {
        groups.forEach(g => listEl.appendChild(renderGroupCard(g)));
      }
    } catch (err) { listEl.textContent = "Ошибка: " + err.message; }
  }

  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      const name = nameInput.value.trim();
      if (!name) { alert("Укажи название группы"); return; }
      try {
        await apiRequest("/api/groups", { method: "POST", body: { name, description: descInput.value.trim() } });
        nameInput.value = "";
        descInput.value = "";
        renderGroups();
      } catch (err) { alert("Ошибка: " + err.message); }
    });
  }

  renderGroups();
}

async function initGroupPage() {
  const me = loadUser();
  initCommonNav();
  initThemeToggle();

  const groupId = new URLSearchParams(window.location.search).get("id");
  const nameEl = document.getElementById("groupViewName");
  const descEl = document.getElementById("groupViewDescription");
  const membersEl = document.getElementById("groupViewMembers");
  const actionsEl = document.getElementById("groupActions");

  if (!groupId) {
    if (nameEl) nameEl.textContent = "Не указан ID группы";
    return;
  }

  async function load() {
    let group;
    try {
      group = await apiRequest(`/api/groups/${encodeURIComponent(groupId)}`);
    } catch (err) {
      if (nameEl) nameEl.textContent = "Группа не найдена";
      return;
    }

    if (nameEl) nameEl.textContent = group.name;
    if (descEl) descEl.textContent = group.description || "";
    if (membersEl) membersEl.textContent = `Участников: ${group.membersCount}`;

    if (actionsEl) {
      actionsEl.innerHTML = "";
      if (group.myRole === "owner") {
        const delBtn = document.createElement("button");
        delBtn.className = "btn";
        delBtn.textContent = "Удалить группу";
        delBtn.addEventListener("click", async () => {
          if (!confirm("Удалить группу безвозвратно?")) return;
          await apiRequest(`/api/groups/${encodeURIComponent(groupId)}`, { method: "DELETE" });
          window.location.href = "groups.html";
        });
        actionsEl.appendChild(delBtn);
      } else if (group.myRole) {
        const leaveBtn = document.createElement("button");
        leaveBtn.className = "btn";
        leaveBtn.textContent = "Выйти из группы";
        leaveBtn.addEventListener("click", async () => {
          try {
            await apiRequest(`/api/groups/${encodeURIComponent(groupId)}/leave`, { method: "POST" });
            load();
          } catch (err) { alert("Ошибка: " + err.message); }
        });
        actionsEl.appendChild(leaveBtn);
      } else {
        const joinBtn = document.createElement("button");
        joinBtn.className = "btn primary";
        joinBtn.textContent = "Вступить";
        joinBtn.addEventListener("click", async () => {
          await apiRequest(`/api/groups/${encodeURIComponent(groupId)}/join`, { method: "POST" });
          load();
        });
        actionsEl.appendChild(joinBtn);
      }
    }

    initWall("wallSection", "group", groupId, !!group.myRole);
  }

  load();
}

// ========================
// ФОТОАЛЬБОМЫ (photos.html)
// ========================

function renderPhotoItem(photo, onDelete) {
  const item = document.createElement("div");
  item.className = "photo-item";
  item.innerHTML = `<img class="photo-img"><button class="photo-delete-btn" title="Удалить">${icon("trash", 13)}</button>`;
  item.querySelector(".photo-img").src = photo.url;
  item.querySelector(".photo-delete-btn").addEventListener("click", () => onDelete(item));
  return item;
}

async function initPhotosPage() {
  const me = loadUser();
  initCommonNav();
  initThemeToggle();

  const albumsListEl = document.getElementById("albumsList");
  const titleInput = document.getElementById("albumTitleInput");
  const createBtn = document.getElementById("albumCreateBtn");
  const currentAlbumEl = document.getElementById("currentAlbumTitle");
  const photoGridEl = document.getElementById("photoGrid");
  const fileInput = document.getElementById("photoFileInput");
  const uploadBtn = document.getElementById("photoUploadBtn");

  let currentAlbumId = null;

  async function loadPhotos(albumId, title) {
    currentAlbumId = albumId;
    if (currentAlbumEl) currentAlbumEl.textContent = title;
    if (!photoGridEl) return;
    photoGridEl.innerHTML = "";
    try {
      const photos = await apiRequest(`/api/albums/${encodeURIComponent(albumId)}/photos`);
      photos.forEach(p => photoGridEl.appendChild(renderPhotoItem(p, async (item) => {
        if (!confirm("Удалить фото?")) return;
        try {
          await apiRequest(`/api/photos/${encodeURIComponent(p.id)}`, { method: "DELETE" });
          item.remove();
        } catch (err) { alert("Ошибка: " + err.message); }
      })));
    } catch (err) { photoGridEl.textContent = "Ошибка: " + err.message; }
  }

  async function renderAlbums() {
    if (!albumsListEl) return;
    albumsListEl.innerHTML = "";
    try {
      const albums = await apiRequest(`/api/albums/${encodeURIComponent(me.id)}`);
      if (!albums.length) {
        albumsListEl.innerHTML = `<p class="muted">Пока нет альбомов.</p>`;
        return;
      }
      albums.forEach(a => {
        const btn = document.createElement("button");
        btn.className = "btn album-btn";
        btn.textContent = a.title;
        btn.addEventListener("click", () => loadPhotos(a.id, a.title));
        albumsListEl.appendChild(btn);
      });
      loadPhotos(albums[0].id, albums[0].title);
    } catch (err) { albumsListEl.textContent = "Ошибка: " + err.message; }
  }

  if (createBtn) {
    createBtn.addEventListener("click", async () => {
      const title = titleInput.value.trim();
      if (!title) return;
      try {
        await apiRequest("/api/albums", { method: "POST", body: { title } });
        titleInput.value = "";
        renderAlbums();
      } catch (err) { alert("Ошибка: " + err.message); }
    });
  }

  if (uploadBtn && fileInput) {
    uploadBtn.addEventListener("click", async () => {
      const file = fileInput.files && fileInput.files[0];
      if (!file) { alert("Выбери файл"); return; }
      if (!currentAlbumId) { alert("Сначала выбери или создай альбом"); return; }
      const form = new FormData();
      form.append("photo", file);
      try {
        await apiRequest(`/api/albums/${encodeURIComponent(currentAlbumId)}/photos`, { method: "POST", body: form });
        fileInput.value = "";
        loadPhotos(currentAlbumId, currentAlbumEl ? currentAlbumEl.textContent : "");
      } catch (err) { alert("Ошибка загрузки: " + err.message); }
    });
  }

  renderAlbums();
}

// ========================
// ROUTER
// ========================

document.addEventListener("DOMContentLoaded", () => {
  initMobileMenu();
  initSidebarCollapse();
  initMobileChatViewport();

  const path = window.location.pathname;

  if (path.endsWith("auth.html")) {
    initAuthPage();
    return;
  }

  const user = loadUser();
  if (!user) {
    window.location.href = "auth.html";
    return;
  }

  // Глобальное WS, чтобы сообщения прилетали на любых страницах
  connectWebSocket();

  if (
    path.endsWith("/") ||
    path.endsWith("index.html") ||
    path === "/" ||
    path === ""
  ) {
    initHomePage();
    return;
  }

  if (path.endsWith("account.html")) {
    initAccountPage();
    return;
  }

  if (path.endsWith("chats.html")) {
    initChatPage();
    return;
  }

  if (path.endsWith("users.html")) {
    initUsersPage();
    return;
  }

  if (path.endsWith("admin.html")) {
    initAdminPage();
    return;
  }

  if (path.endsWith("music.html")) {
    initMediaPage("music");
    return;
  }

  if (path.endsWith("video.html")) {
    initMediaPage("video");
    return;
  }

  if (path.endsWith("books.html")) {
    initMediaPage("books");
    return;
  }

  if (path.endsWith("profile.html")) {
    initProfilePage();
    return;
  }

  if (path.endsWith("friends.html")) {
    initFriendsPage();
    return;
  }

  if (path.endsWith("groups.html")) {
    initGroupsPage();
    return;
  }

  if (path.endsWith("group.html")) {
    initGroupPage();
    return;
  }

  if (path.endsWith("photos.html")) {
    initPhotosPage();
    return;
  }

  initCommonNav();
  initThemeToggle();
});
