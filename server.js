const express = require("express");
const cors = require("cors");
const sqlite3 = require("sqlite3").verbose();
const nodemailer = require("nodemailer");

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());

// DATABASE
const db = new sqlite3.Database("./database.db");

// EMAIL SETUP
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "taskmessengerai@gmail.com",
    pass: "hues qvcj gnlh zclf"
  }
});

// CREATE TABLES
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT UNIQUE,
      password TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT,
      desc TEXT,
      priority TEXT,
      reminder TEXT,
      due_date TEXT,
      completed INTEGER DEFAULT 0
    )
  `);

  // Add due_date column if it doesn't exist (for existing databases)
  db.run(`ALTER TABLE tasks ADD COLUMN due_date TEXT`, () => {});
});

// TEST ROUTE
app.get("/", (req, res) => {
  res.send("TaskFlow server running!");
});

// SIGNUP
app.post("/signup", (req, res) => {
  const { name, email, password } = req.body;
  db.run(
    "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
    [name, email, password],
    function (err) {
      if (err) return res.json({ success: false, message: "Account already exists." });
      res.json({ success: true, message: "Account created!" });
    }
  );
});

// LOGIN
app.post("/login", (req, res) => {
  const { email, password } = req.body;
  db.get(
    "SELECT * FROM users WHERE email = ? AND password = ?",
    [email, password],
    (err, user) => {
      if (!user) return res.json({ success: false, message: "Invalid email or password." });
      res.json({ success: true, userId: user.id, name: user.name, email: user.email });
    }
  );
});

// GET TASKS
app.get("/tasks/:userId", (req, res) => {
  const userId = req.params.userId;
  db.all("SELECT * FROM tasks WHERE user_id = ?", [userId], (err, rows) => {
    if (err) { console.log(err); return res.json([]); }
    res.json(rows);
  });
});

// ADD TASK + SEND EMAIL
app.post("/tasks", (req, res) => {
  const { userId, title, desc, priority, reminder, dueDate, email } = req.body;

  db.run(
    "INSERT INTO tasks (user_id, title, desc, priority, reminder, due_date, completed) VALUES (?, ?, ?, ?, ?, ?, 0)",
    [userId, title, desc, priority, reminder, dueDate || null],
    function (err) {
      if (err) { console.log("DB error:", err); return res.json({ success: false }); }

      // SEND EMAIL
      const dueLine = dueDate ? `\nDue Date: ${dueDate}` : "";
      transporter.sendMail({
        from: "taskmessengerai@gmail.com",
        to: email,
        subject: `New Task Created: ${title}`,
        text: `You created a new task!\n\nTask: ${title}\nDescription: ${desc}\nPriority: ${priority}${dueLine}\nReminder: ${reminder}`
      }, (error, info) => {
        if (error) console.log("Email error:", error);
        else console.log("Email sent:", info.response);
      });

      res.json({ success: true });
    }
  );
});

// EDIT TASK (PATCH)
app.patch("/tasks/:id", (req, res) => {
  const id = req.params.id;
  const { title, desc, priority, dueDate } = req.body;

  db.run(
    "UPDATE tasks SET title = ?, desc = ?, priority = ?, due_date = ? WHERE id = ?",
    [title, desc, priority, dueDate || null, id],
    (err) => {
      if (err) { console.log(err); return res.json({ success: false }); }
      res.json({ success: true });
    }
  );
});

// COMPLETE TASK
app.put("/tasks/:id", (req, res) => {
  const id = req.params.id;
  db.run("UPDATE tasks SET completed = 1 WHERE id = ?", [id], (err) => {
    if (err) { console.log(err); return res.json({ success: false }); }
    res.json({ success: true });
  });
});

// DELETE TASK
app.delete("/tasks/:id", (req, res) => {
  const id = req.params.id;
  db.run("DELETE FROM tasks WHERE id = ?", [id], (err) => {
    if (err) { console.log(err); return res.json({ success: false }); }
    res.json({ success: true });
  });
});

// START SERVER
app.listen(PORT, () => {
  console.log(`TaskFlow server running on http://localhost:${PORT}`);
});