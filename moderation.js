// ========================
// ЛОКАЛЬНАЯ МОДЕРАЦИЯ (офлайн, без внешних сервисов и без ключей API)
// ========================
// Автономно проверяет текст постов/комментариев и загруженные "картинки"
// перед публикацией — без ручного вмешательства админа для чистого контента.
// Это НЕ настоящий AI: фильтр не понимает смысл текста, а сопоставляет его
// с известными паттернами (мат, оскорбления, спам, угрозы по признаку
// группы людей) и проверяет файлы по сигнатуре байтов. Реальный анализ
// содержимого картинок (что на фото) офлайн недоступен — для фото
// проверяется только то, что файл на самом деле является заявленным
// форматом изображения (см. isRealImage), содержимое не анализируется.

// Обфускация под фильтры обычно работает через: leet-замены цифрами,
// латиницу вместо похожей кириллицы, лишние разделители внутри слова
// ("с.у.к.а", "хyйня" через латинскую y). Нормализация ниже отменяет все три
// приёма, но работает ПОСЛОВНО (по пробельным границам), чтобы не склеивать
// случайно разные слова в один длинный текст и не плодить ложные срабатывания.
const LEET_MAP = {
  "0": "о", "1": "и", "3": "е", "4": "а", "5": "с", "6": "б", "7": "т", "8": "в", "9": "д",
  "@": "а", "$": "с"
};
const LATIN_TO_CYR = {
  a: "а", c: "с", e: "е", o: "о", p: "р", x: "х", y: "у", b: "в", k: "к", m: "м", h: "н", t: "т", n: "п"
};

function normalizeWord(word) {
  let s = word.toLowerCase().replace(/[._\-*'"`~^]/g, "");
  s = s.replace(/[a-z0-9@$]/g, (ch) => LEET_MAP[ch] || LATIN_TO_CYR[ch] || ch);
  return s;
}

function normalizedWords(text) {
  return (text || "").split(/\s+/).filter(Boolean).map(normalizeWord);
}

// Корни матерных слов — вхождение подстроки ловит и склонения/спряжения.
const HARD_ROOTS = ["хуй", "хуе", "хуё", "пизд", "ебат", "ёб", "бляд", "блят"];
// Оскорбления по национальному/этническому признаку.
const SLUR_ROOTS = ["негр", "жид", "чурк", "хач", "узкоглаз"];
// Более мягкие грубые оскорбления — не мат, но явно агрессивные в адрес человека.
const SOFT_ROOTS = ["мудак", "гнида", "уёбок", "уебок", "тварь", "долбоёб", "долбоеб", "сука"];

// Эвристика разжигания вражды: слово-обозначение группы людей + угроза/
// насилие в одном тексте — без явного мата, но по совокупности похоже на
// угрозу в адрес группы (напр. "евреи пожалеют", "депортировать хохлов").
// Корни намеренно короткие — у многих русских слов "плавающая" гласная в
// склонении (хохол/хохлы), полная форма-подстрока склонение не ловит.
const GROUP_ROOTS = ["евре", "мусульман", "хохл", "москал", "кацап", "цыган", "армян", "азер", "негр", "гей", "лесбиян"];
const THREAT_ROOTS = ["убь", "убива", "уничтож", "сдохн", "вымр", "депортир", "истреб", "пожале", "виноват"];

function matchAnyRoot(words, roots) {
  return words.some((w) => roots.some((r) => w.includes(r)));
}

function countUrls(text) {
  const m = (text || "").match(/https?:\/\/|www\./gi);
  return m ? m.length : 0;
}

function capsRatio(text) {
  const letters = (text || "").replace(/[^a-zA-Zа-яА-ЯёЁ]/g, "");
  if (letters.length < 12) return 0;
  const caps = letters.replace(/[^A-ZА-ЯЁ]/g, "").length;
  return caps / letters.length;
}

function hasLongRepeat(text) {
  return /(.)\1{7,}/.test(text || "");
}

// Возвращает { action: 'reject'|'flag'|'clean', reasons: string[] }.
// 'reject' — публикация блокируется сразу (autonomous hard-block), автору
// возвращается ошибка с причиной. 'flag' — публикуется, но скрыта из
// ленты/стены для всех, кроме автора и админа, до ручной проверки в
// админке. 'clean' — публикуется как обычно, без вмешательства.
function moderateText(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return { action: "clean", reasons: [] };

  const words = normalizedWords(trimmed);
  const reasons = [];
  let score = 0;

  if (matchAnyRoot(words, HARD_ROOTS)) { score += 100; reasons.push("нецензурная лексика"); }
  if (matchAnyRoot(words, SLUR_ROOTS)) { score += 100; reasons.push("оскорбление по национальному признаку"); }
  if (matchAnyRoot(words, GROUP_ROOTS) && matchAnyRoot(words, THREAT_ROOTS)) {
    score += 100;
    reasons.push("похоже на угрозу/разжигание вражды в адрес группы людей");
  }
  if (matchAnyRoot(words, SOFT_ROOTS)) { score += 40; reasons.push("грубые оскорбления"); }
  if (countUrls(trimmed) >= 3) { score += 30; reasons.push("похоже на спам-рассылку ссылок"); }
  if (capsRatio(trimmed) > 0.7) { score += 20; reasons.push("капс"); }
  if (hasLongRepeat(trimmed)) { score += 15; reasons.push("похоже на спам (повторы символов)"); }

  if (score >= 80) return { action: "reject", reasons };
  if (score >= 30) return { action: "flag", reasons };
  return { action: "clean", reasons: [] };
}

// ===== Проверка файла по сигнатуре байт (magic bytes) =====
// Ловит случай, когда загруженный файл выдаёт себя за картинку (через
// подделанный Content-Type в multipart-запросе), а на самом деле ей не
// является — доп. слой поверх уже существующей проверки mimetype в multer.
const IMAGE_SIGNATURES = [
  (b) => b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff, // JPEG
  (b) => b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47, // PNG
  (b) => b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46, // GIF
  (b) => b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP" // WEBP
];

// buffer — первые ~16 байт файла. true, если это реально один из
// поддерживаемых форматов картинок (содержимое самой картинки не
// анализируется — только целостность формата).
function isRealImage(buffer) {
  return IMAGE_SIGNATURES.some((check) => check(buffer));
}

export { moderateText, isRealImage };
