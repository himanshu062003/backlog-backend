// backend/index.js
import express from "express";
import cors from "cors";
import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import mongoose, { Schema } from "mongoose";

// ---------- CONFIG ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

// Environment / keys (set in env in production)
const PORT = process.env.PORT || 8000;
const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://class10basti_db_user:qWsq3ASgMEjHaggg@backlog.zguvekd.mongodb.net/backlog_db?retryWrites=true&w=majority";

// ADMIN key for uploading & verifying
const ADMIN_KEY = process.env.ADMIN_KEY || "himanshu";
// SUBMIT key for submitting answers
const SUBMIT_KEY = process.env.SUBMIT_KEY || "himanshu2";

// ---------- MONGOOSE MODELS ----------
await mongoose
  .connect(MONGO_URI, { })
  .then(() => console.log("Connected to MongoDB"))
  .catch((err) => {
    console.error("Error connecting to MongoDB: ", err);
    process.exit(1);
  });

const AnswerSchema = new Schema({
  taskId: { type: Schema.Types.ObjectId, ref: "Task", required: true },
  text: { type: String, required: true },
  submitter: { type: String, default: "anonymous" },
  createdAt: { type: Date, default: Date.now },
  verified: { type: Boolean, default: false },
  verifiedBy: { type: String, default: null },
  verifiedAt: { type: Date, default: null },
});

const TaskSchema = new Schema({
  text: { type: String, required: true },
  imagePath: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["pending", "done"], default: "pending" },
  doneAt: { type: Date, default: null },
});

const Task = mongoose.model("Task", TaskSchema);
const Answer = mongoose.model("Answer", AnswerSchema);

// ---------- MULTER SETUP ----------
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 5 * 1024 * 1024 } }); // 5MB limit

// serve uploads statically
app.use("/uploads", express.static(uploadDir));

// ---------- HELPERS ----------
function sameCalendarDate(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return a.getFullYear() === b.getFullYear() &&
         a.getMonth() === b.getMonth() &&
         a.getDate() === b.getDate();
}

// ---------- ROUTES ----------

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Create task (admin)
app.post("/api/tasks", upload.single("image"), async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: "Invalid admin key" });
    }
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

    const imagePath = req.file ? `/uploads/${req.file.filename}` : null;
    const task = new Task({ text: text.trim(), imagePath });
    await task.save();
    return res.json({ message: "Task created", task });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// List tasks (optionally filter by status)
app.get("/api/tasks", async (req, res) => {
  try {
    const status = req.query.status; // pending | done | (all)
    const q = status ? { status } : {};
    const tasks = await Task.find(q).sort({ createdAt: -1 }).lean();
    return res.json(tasks);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Get single task + answers
app.get("/api/tasks/:id", async (req, res) => {
  try {
    const task = await Task.findById(req.params.id).lean();
    if (!task) return res.status(404).json({ error: "Task not found" });
    const answers = await Answer.find({ taskId: task._id }).sort({ createdAt: -1 }).lean();
    return res.json({ task, answers });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Submit an answer (requires SUBMIT_KEY)
app.post("/api/tasks/:id/answers", async (req, res) => {
  try {
    const submitKey = req.headers["x-submit-key"] || req.body.submitKey;
    if (submitKey !== SUBMIT_KEY) {
      return res.status(401).json({ error: "Invalid submit key" });
    }
    const { text, submitter } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    const answer = new Answer({
      taskId: task._id,
      text: text.trim(),
      submitter: submitter || "anonymous",
    });
    await answer.save();
    return res.json({ message: "Answer submitted and pending verification", answer });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Admin verifies an answer -> marks answer verified, marks task done, calculates backlog condition
app.post("/api/answers/:id/verify", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) {
      return res.status(401).json({ error: "Invalid admin key" });
    }
    const answer = await Answer.findById(req.params.id);
    if (!answer) return res.status(404).json({ error: "Answer not found" });
    if (answer.verified) return res.status(400).json({ error: "Already verified" });

    answer.verified = true;
    answer.verifiedBy = "admin";
    answer.verifiedAt = new Date();
    await answer.save();

    // Mark task done if not already
    const task = await Task.findById(answer.taskId);
    if (task && task.status !== "done") {
      task.status = "done";
      task.doneAt = new Date();
      await task.save();
    }

    // We'll compute backlog on-the-fly in /api/backlog-count
    return res.json({ message: "Answer verified and task marked done", answer, task });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Backlog count = number of tasks that were completed the same calendar date they were created
app.get("/api/backlog-count", async (req, res) => {
  try {
    const doneTasks = await Task.find({ status: "done" }).lean();
    let cnt = 0;
    doneTasks.forEach((t) => {
      if (t.doneAt && sameCalendarDate(t.createdAt, t.doneAt)) cnt++;
    });
    return res.json({ backlog: cnt });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Optional: Admin can delete task (and its answers + image) (admin only)
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Invalid admin key" });

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // delete image file if exists
    if (task.imagePath) {
      const imageFull = path.join(__dirname, task.imagePath.replace("/uploads/", ""));
      try { fs.unlinkSync(imageFull); } catch (e) {}
    }

    await Answer.deleteMany({ taskId: task._id });
    await Task.deleteOne({ _id: task._id });

    return res.json({ message: "Task and its answers deleted" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// place this in backend/index.js (replace the older /api/backlog route)
app.get("/api/backlog", async (req, res) => {
    try {
      // create date range for "today" in server local time
      const now = new Date();
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
      const startOfTomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  
      // total pending tasks (all-time pending backlog)
      const totalPending = await Task.countDocuments({ status: "pending" });
  
      // pending tasks created today
      const todayPending = await Task.countDocuments({
        status: "pending",
        createdAt: { $gte: startOfToday, $lt: startOfTomorrow },
      });
  
      return res.json({ todayPending, totalPending });
    } catch (err) {
      console.error("Error computing backlog:", err);
      return res.status(500).json({ error: "Server error" });
    }
  });
  
  

// ---------- Start ----------
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend is running on http://0.0.0.0:${PORT}`);
});
