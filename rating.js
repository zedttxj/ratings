const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { MongoClient } = require("mongodb");

const app = express();
const PORT = 4000;


// MongoDB connection
const mongoUri = "mongodb://localhost:27017";
const mongoClient = new MongoClient(mongoUri);
let ratingsCollection;

// const publicKey = fs.readFileSync(path.join(__dirname, './inter-service-public.pem'), 'utf-8');
const { runAuthenticatedClient, requestCertificateFromHub } = require('../roomtest/clientCertRequester'); // Adjust this path first
let publicKey;

(async () => {
  const issued = await requestCertificateFromHub();
  const certificate = issued.certificate;
  const privateKey = issued.privateKey;
  const caPublicKey = issued.caPublicKey;
  const roomId = issued.roomId;
  const result = await runAuthenticatedClient("ws://localhost:8888/hub", certificate, privateKey, caPublicKey, roomId);
  publicKey = result.clientPubKey;
  console.log(certificate);
  console.log(publicKey);
})();

async function connectToMongo() {
  await mongoClient.connect();
  const db = mongoClient.db("ratingsDB");
  ratingsCollection = db.collection("ratings");
  await ratingsCollection.createIndex({ rater: 1, target: 1, roomId: 1, timestamp: -1 });
  console.log("📦 Connected to MongoDB");

  // ✅ Only start listening after DB is ready
  app.listen(PORT, () => {
    console.log(`🎯 Rating service running at http://localhost:${PORT}`);
  });
}

connectToMongo();

app.use(cors());
app.use(express.json());

function verifyJWT(token) {
  try {
    return jwt.verify(token, publicKey, { algorithms: ["RS256"] });
  } catch (err) {
    console.warn("Invalid JWT:", err.message);
    return null;
  }
}

async function hasRatedRecently(rater, target, roomId, now, cooldownHours = 24) {
    const cutoff = new Date(now.getTime() - cooldownHours * 3600 * 1000);
    const recent = await ratingsCollection.findOne({
        rater,
        target,
        roomId,
        timestamp: { $gt: cutoff },
    });
    return !!recent;
}

async function hasReceivedTooManyRatings(target, roomId, now, maxPerDay = 5) {
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0); // Midnight today

  const count = await ratingsCollection.countDocuments({
    target,
    roomId,
    timestamp: { $gte: startOfDay }
  });

  return count >= maxPerDay;
}

async function addRating(rater, target, roomId, emoji, timestamp) {
    const doc = { rater, target, roomId, emoji, timestamp };
    await ratingsCollection.insertOne(doc);
    await updateStats(rater, target, roomId, emoji);
}

app.post("/api/rating", async (req, res) => {
  if (!ratingsCollection) {
    return res.status(503).json({ success: false, error: "Database not ready" });
  }
  const token = req.body.token;
  const parsed = verifyJWT(token);

  if (!parsed || !parsed.clientId || !parsed.targetClientId || !parsed.emoji) {
    return res.status(400).json({ success: false, error: "Invalid rating token" });
  }

  const { clientId: rater, targetClientId: target, emoji, roomId} = parsed;
  const timestamp = new Date();

  if (await hasReceivedTooManyRatings(target, roomId, timestamp) && await hasRatedRecently(rater, target, roomId, timestamp)) {
    return res.status(429).json({ success: false, message: "Already rated recently" });
  }

  await addRating(rater, target, roomId, emoji, timestamp);
  console.log(`✅ Rating recorded: ${rater} ➜ ${target} = ${emoji}`);

  res.json({ success: true});
});


//


async function updateStats(rater, target, roomId, emoji) {
  const emojiScores = { "🌖": 4, "🌕": 5, "🌗": 3, "🌘": 2, "🌑": 1 };
  const score = emojiScores[emoji] ?? 0;

  const statsCol = mongoClient.db("ratingsDB").collection("ratingStats");

  // Update rater's "given" stats
  await statsCol.updateOne(
    { clientId: rater, roomId },
    { $inc: { ratingsGiven: 1 } },
    { upsert: true }
  );

  // Update target's "received" stats and score sum
  await statsCol.updateOne(
    { clientId: target, roomId },
    {
      $inc: {
        ratingsReceived: 1,
        scoreSum: score
      }
    },
    { upsert: true }
  );
}

// async function getSummariesFromStats(clientIds, roomId = null) {
//   const query = {
//     clientId: { $in: clientIds }
//   };
//   if (roomId) query.roomId = roomId;

//   const statsCol = mongoClient.db("ratingsDB").collection("ratingStats");
//   const docs = await statsCol.find(query).toArray();

//   return docs.map(doc => ({
//     clientId: doc.clientId,
//     ratingsGiven: doc.ratingsGiven ?? 0,
//     ratingsReceived: doc.ratingsReceived ?? 0,
//     averageEmojiScore: doc.ratingsReceived
//       ? (doc.scoreSum / doc.ratingsReceived).toFixed(2)
//       : "0.00"
//   }));
// }

app.post("/api/summary", async (req, res) => {
  const { clientIds } = req.body;
  const statsCol = mongoClient.db("ratingsDB").collection("ratingStats");
  const docs = await statsCol.find({ clientId: { $in: clientIds } }).toArray();

  const result = {};
  for (const doc of docs) {
    result[doc.clientId] = {
      given: doc.ratingsGiven ?? 0,
      received: doc.ratingsReceived ?? 0,
      avg: doc.ratingsReceived
        ? +(doc.scoreSum / doc.ratingsReceived).toFixed(2)
        : 0,
    };
  }

  res.json(result);
});
