// @ts-nocheck
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion } = require("mongodb");
const { ObjectId } = require("mongodb");
// Load environment variables
dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB URI
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r355ogr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");

    const db = client.db("parcelDelivery");
    const parcelsCollection = db.collection("parcels");

    app.get("/parcels", async (req, res) => {
      const parcels = await parcelsCollection.find().toArray();
      res.send(parcels);
    });

    //  get all parcel or parcel by  by user (created_by)
    app.get("/parcels", async (req, res) => {
      try {
        const email = req.query.email;
        const query = email ? { created_by: email } : {}; // Optional filter

        const parcels = await parcelsCollection
          .find(query)
          .sort({ creation_date: -1 }) // Newest first
          .toArray();

        res.send(parcels);
      } catch (error) {
        console.error("Error getting parcels:", error);
        res.status(500).send({ error: "Failed to fetch parcels" });
      }
    });

    // post api create a new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;

        if (!newParcel || Object.keys(newParcel).length === 0) {
          return res.status(400).send({ message: "Invalid parcel data" });
        }

        // Add createdAt timestamp
        // newParcel.createdAt = new Date();

        const result = await parcelsCollection.insertOne(newParcel);
        res.status(201).send({
          message: "Parcel added successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("❌ Failed to insert parcel:", error);
        res.status(500).send({ message: "Failed to add parcel" });
      }
    });

    // DELETE a parcel by ID
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;

        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });
        res.send(result);
      } catch (error) {
        console.error("❌ Error deleting parcel:", error);
        res
          .status(500)
          .send({ success: false, message: "Internal server error" });
      }
    });
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
  }
}
run();

app.get("/", (req, res) => {
  res.send("📦 Parcel Delivery API is running");
});

app.listen(port, () => {
  console.log(`🚀 Server is running on port ${port}`);
});
