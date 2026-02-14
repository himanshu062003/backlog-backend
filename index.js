// backend/index.js
import express from "express";
import cors from "cors";
import multer from "multer";
import path from "path";
import { fileURLToPath } from "url";
import mongoose, { Schema } from "mongoose";
import axios from "axios";

// ---------- CONFIG ----------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8000;
const MONGO_URI = process.env.MONGO_URI;
const ADMIN_KEY = process.env.ADMIN_KEY;
const SUBMIT_KEY = process.env.SUBMIT_KEY;
const IMGBB_KEY = process.env.IMGBB_API_KEY; // <-- set this in env

if (!IMGBB_KEY) {
  console.warn("Warning: IMGBB_API_KEY not set. Image uploads will fail until set.");
}

// ---------- MONGOOSE MODELS ----------
await mongoose
  .connect(MONGO_URI, {})
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
  imagePath: { type: String, default: null },      // public image URL
  imageDeleteUrl: { type: String, default: null }, // (optional) delete URL returned by imgbb
  createdAt: { type: Date, default: Date.now },
  status: { type: String, enum: ["pending", "done"], default: "pending" },
  doneAt: { type: Date, default: null },
});

const Task = mongoose.model("Task", TaskSchema);
const Answer = mongoose.model("Answer", AnswerSchema);

// ---------- MULTER SETUP (memory storage) ----------
const storage = multer.memoryStorage(); // store file in memory buffer
const upload = multer({ storage, limits: { fileSize: 8 * 1024 * 1024 } }); // 8MB limit

// ---------- HELPERS ----------
function sameCalendarDate(d1, d2) {
  const a = new Date(d1);
  const b = new Date(d2);
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

async function uploadBufferToImgBB(buffer, originalName) {
  if (!IMGBB_KEY) throw new Error("IMGBB_API_KEY not configured");

  // imgbb API accepts base64 image in `image` form field
  const base64 = buffer.toString("base64");
  const params = new URLSearchParams();
  params.append("key", IMGBB_KEY);
  params.append("image", base64);
  // optional: provide a name
  params.append("name", `${Date.now()}-${path.basename(originalName)}`);

  const resp = await axios.post("https://api.imgbb.com/1/upload", params.toString(), {
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 30_000,
  });

  // Successful response shape: resp.data.data (contains url, display_url, delete_url maybe)
  if (resp.data && resp.data.data) {
    return {
      url: resp.data.data.url || resp.data.data.display_url || null,
      deleteUrl: resp.data.data.delete_url || resp.data.data.deleteUrl || null,
      raw: resp.data,
    };
  } else {
    throw new Error("Unexpected imgbb response: " + JSON.stringify(resp.data));
  }
}

// ---------- ROUTES ----------

// Health
app.get("/api/health", (req, res) => res.json({ ok: true }));

// Create task (admin) -- now uploads to imgbb instead of local disk
app.post("/api/tasks", upload.single("image"), async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Invalid admin key" });

    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: "text required" });

    let imagePath = null;
    let imageDeleteUrl = null;

    if (req.file) {
      try {
        const result = await uploadBufferToImgBB(req.file.buffer, req.file.originalname);
        imagePath = result.url;
        imageDeleteUrl = result.deleteUrl || null;
      } catch (uploadErr) {
        console.error("Image upload failed:", uploadErr?.message || uploadErr);
        return res.status(500).json({ error: "Image upload failed", details: uploadErr?.message });
      }
    }

    const task = new Task({ text: text.trim(), imagePath, imageDeleteUrl });
    await task.save();
    return res.json({ message: "Task created", task });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// List tasks
app.get("/api/tasks", async (req, res) => {
  try {
    const status = req.query.status;
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
    if (submitKey !== SUBMIT_KEY) return res.status(401).json({ error: "Invalid submit key" });

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

// Admin verifies answer
app.post("/api/answers/:id/verify", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Invalid admin key" });

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

    return res.json({ message: "Answer verified and task marked done", answer, task });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Backlog count
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

// Delete task (admin). If imagePath is remote URL, we skip local unlinking.
app.delete("/api/tasks/:id", async (req, res) => {
  try {
    const adminKey = req.headers["x-admin-key"] || req.body.adminKey;
    if (adminKey !== ADMIN_KEY) return res.status(401).json({ error: "Invalid admin key" });

    const task = await Task.findById(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    // If you saved a delete URL from the image host, you can use it to remove the remote image.
    // We saved imageDeleteUrl earlier (if imgbb provided one). If present, you could call it here.
    // For now, skip local unlink since files are not stored locally.

    await Answer.deleteMany({ taskId: task._id });
    await Task.deleteOne({ _id: task._id });

    return res.json({ message: "Task and its answers deleted" });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: "Server error" });
  }
});

// backlog route you had
app.get("/api/backlog", async (req, res) => {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
    const startOfTomorrow = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
      0,
      0,
      0,
      0
    );

    const totalPending = await Task.countDocuments({ status: "pending" });

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

