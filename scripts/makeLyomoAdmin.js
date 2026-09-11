import "dotenv/config";
import db from "../db.js";

const result = db.prepare("UPDATE users SET isAdmin = 1 WHERE login = ?").run("Lyomo");

if (result.changes === 0) {
  console.log('Пользователь "Lyomo" не найден в базе — ничего не обновлено.');
} else {
  console.log('Готово: "Lyomo" теперь администратор (isAdmin: true).');
}
