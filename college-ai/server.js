require("dotenv").config();
const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`;

// ---------- In-memory cache (per hallticket, 5 min TTL) ----------
const resultCache = new Map(); // hallticket -> { data, timestamp }
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ---------- In-memory session store (per sessionId) ----------
const sessions = new Map(); // sessionId -> { hallticket }

// ---------- Extract hall ticket number from free text ----------
// function extractHallTicket(text) {
//   let cleaned = text.toLowerCase();

//   // Replace commonly mis-heard spoken numbers with digits
//   const wordToDigit = {
//     zero: "0", oh: "0",
//     one: "1", won: "1",
//     two: "2", too: "2", to: "2",
//     three: "3",
//     four: "4", for: "4",
//     five: "5",
//     six: "6",
//     seven: "7",
//     eight: "8", ate: "8",
//     nine: "9",
//   };

//   cleaned = cleaned.replace(/\b(zero|oh|one|won|two|too|to|three|four|for|five|six|seven|eight|ate|nine)\b/g,
//     (match) => wordToDigit[match]
//   );

//   // Strip everything except letters and digits (removes spaces, commas, periods)
//   const squashed = cleaned.replace(/[^a-z0-9]/g, "");

//   // Flexible match: 2 digits + 2 letters + 1 digit + 1 letter + 3-4 digits
//   const match = squashed.match(/\d{2}[a-z]{2}\d[a-z]\d{3,4}/);

//   return match ? match[0].toUpperCase() : null;
// }



function extractHallTicket(text) {
  let cleaned = text.toLowerCase();

  const wordToDigit = {
    zero: "0", oh: "0",
    one: "1", won: "1",
    two: "2", too: "2", to: "2",
    three: "3",
    four: "4", for: "4",
    five: "5",
    six: "6",
    seven: "7",
    eight: "8",
    nine: "9",
  };

  cleaned = cleaned.replace(/\b(zero|oh|one|won|two|too|to|three|four|for|five|six|seven|eight|ate|nine)\b/g,
    (match) => wordToDigit[match]
  );
  cleaned = cleaned.replace(/\balpha\b/g, "a");

  const squashed = cleaned.replace(/[^a-z0-9]/g, "");

  // Try the strict correct pattern first: 2 digits + 2 letters + 1 digit + 1 letter + 4 digits
  let match = squashed.match(/\d{2}[a-z]{2}\d[a-z]\d{4}/);

  if (!match) {
    // Auto-correct: if position 5 was misheard as "8" instead of the letter "A",
    // e.g. "23xu180578" -> "23xu1a0578"
    const altMatch = squashed.match(/(\d{2}[a-z]{2}\d)8(\d{4})/);
    if (altMatch) {
      match = [altMatch[1] + "a" + altMatch[2]];
    }
  }

  return match ? match[0].toUpperCase() : null;
}
// ---------- Shared: fetch + parse result (with caching) ----------
async function getResult(hallticket) {
  const cached = resultCache.get(hallticket);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.data;
  }

  const response = await axios.get(
    "https://wesleyengineeringcollege.com/results.csiwits/multiple-results",
    {
      params: { q: hallticket },
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
      },
    }
  );

  const $ = cheerio.load(response.data);

  const infoValues = [];
  $(".profile-grid .info-group").each((i, el) => {
    infoValues.push({
      label: $(el).find(".info-label").text().trim(),
      value: $(el).find(".info-value").text().trim(),
    });
  });
  const getInfo = (label) =>
    infoValues.find((i) => i.label.toLowerCase().includes(label.toLowerCase()))?.value || null;

  const profile = {
    name: $(".profile-name").first().text().trim(),
    hallTicket: getInfo("Hall Ticket"),
    fatherName: getInfo("Father"),
    collegeCode: getInfo("College Code"),
    regulation: getInfo("Regulation"),
    currentBacklogs: $(".total-backlogs-badge h3").first().text().trim(),
  };

  const semesters = [];
  $(".sem-block").each((i, semEl) => {
    const semesterName = $(semEl).find(".sem-header h2").text().trim();
    const sgpa = $(semEl).find(".stat-sgpa").text().replace(/[^\d.]/g, "").trim();
    const credits = $(semEl).find(".stat-credits").text().replace(/[^\d.]/g, "").trim();
    const backlogs = $(semEl).find(".sem-stats span:contains('BL')").text().replace(/\D/g, "").trim();

    const subjects = [];
    $(semEl).find(".results-table tbody tr").each((j, row) => {
      const cells = $(row).find("td");
      if (cells.length < 6) return;
      const subjectCell = $(cells[1]);
      const marksSplit = subjectCell.find(".marks-split").text().trim();
      const subjectName = subjectCell.clone().find(".marks-split").remove().end().text().trim();

      subjects.push({
        code: $(cells[0]).text().trim(),
        subject: subjectName,
        marksSplit: marksSplit || null,
        totalMarks: $(cells[2]).text().trim(),
        grade: $(cells[3]).find(".grade-badge").text().trim(),
        points: $(cells[4]).text().trim(),
        credits: $(cells[5]).text().trim(),
        date: $(cells[6]).text().trim(),
      });
    });

    semesters.push({ semesterName, sgpa, credits, backlogs, subjects });
  });

  const data = { profile, semesters };
  resultCache.set(hallticket, { data, timestamp: Date.now() });
  return data;
}

// ---------- CGPA calculation ----------
function calculateCgpa(semesters) {
  let totalPoints = 0;
  let totalCredits = 0;

  semesters.forEach((sem) => {
    sem.subjects.forEach((sub) => {
      const credits = parseFloat(sub.credits) || 0;
      const points = parseFloat(sub.points) || 0;
      totalPoints += credits * points;
      totalCredits += credits;
    });
  });

  return totalCredits > 0 ? (totalPoints / totalCredits).toFixed(2) : "0.00";
}

// ---------- Result endpoint ----------
app.get("/api/result/:hallticket", async (req, res) => {
  try {
    const data = await getResult(req.params.hallticket.toUpperCase());
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch result", details: err.message });
  }
});

// ---------- Chat endpoint (session-aware, Gemini) ----------
app.post("/api/chat", async (req, res) => {
  const { sessionId, message } = req.body;

  if (!sessionId || !message) {
    return res.status(400).json({ error: "sessionId and message are required" });
  }

  // Get or create session
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, { hallticket: null });
  }
  const session = sessions.get(sessionId);

  // If the message mentions a hall ticket, capture/update it in the session
  const foundHallTicket = extractHallTicket(message);
  if (foundHallTicket) {
    session.hallticket = foundHallTicket;
  }

  // If we still don't have a hall ticket for this session, ask for it
  if (!session.hallticket) {
    return res.json({
      reply: "Sure — could you tell me your hall ticket number first? For example, 23XU1A0578.",
      needsHallTicket: true,
    });
  }

  try {
    const data = await getResult(session.hallticket);
    const cgpa = calculateCgpa(data.semesters);

    const summary = {
      name: data.profile.name,
      hallTicket: data.profile.hallTicket,
      currentBacklogs: data.profile.currentBacklogs,
      cgpa,
      semesters: data.semesters.map((s) => ({
        semester: s.semesterName,
        sgpa: s.sgpa,
        backlogs: s.backlogs,
        subjects: s.subjects.map((sub) => ({
          subject: sub.subject,
          grade: sub.grade,
          totalMarks: sub.totalMarks,
        })),
      })),
    };

    const prompt = `You are a friendly college result assistant. Answer the student's question using ONLY the data provided below. Be concise and clear, and speak naturally since your reply may be read aloud. If the data doesn't contain the answer, say so honestly.

Student Data:
${JSON.stringify(summary, null, 2)}

Student's question: ${message}`;

    const geminiResponse = await axios.post(
      GEMINI_URL,
      { contents: [{ parts: [{ text: prompt }] }] },
      { headers: { "Content-Type": "application/json" } }
    );

    const reply =
      geminiResponse.data.candidates?.[0]?.content?.parts?.[0]?.text ||
      "Sorry, I couldn't generate a response.";

    res.json({ reply, cgpa, hallticket: session.hallticket });
  } catch (err) {
    console.error("FULL ERROR:", err.response?.data || err.message);
    res.status(500).json({
      error: "Chat failed",
      details: err.response?.data || err.message,
    });
  }
});

app.listen(5000, () => console.log("Server running on http://localhost:5000"));