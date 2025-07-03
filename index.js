// @ts-nocheck
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);

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
    console.log("✅ Connected to MongoDB");

    const db = client.db("parcelDelivery");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking_updates");
    const usersCollection = db.collection("users"); // ✅ New users collection

    // ✅ Register new user
    app.post("/api/users", async (req, res) => {
      try {
        const user = req.body;

        if (!user || !user.email) {
          return res.status(400).send({ message: "Invalid user data" });
        }

        // Prevent duplicate registration
        const existingUser = await usersCollection.findOne({
          email: user.email,
        });
        if (existingUser) {
          return res.status(409).send({ message: "User already exists" });
        }

        const result = await usersCollection.insertOne({
          ...user,
          role: user.role || "user",
          createdAt: new Date(),
        });

        res.status(201).send({
          message: "User registered successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("❌ Failed to register user:", error);
        res.status(500).send({ message: "Failed to register user" });
      }
    });

    // 📦 Get all parcels or filter by user
    app.get("/parcels", async (req, res) => {
      try {
        const email = req.query.email;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const query = email ? { created_by: email } : {};

        const [total, parcels] = await Promise.all([
          parcelsCollection.countDocuments(query),
          parcelsCollection
            .find(query)
            .sort({ creation_date: -1 })
            .skip(skip)
            .limit(limit)
            .toArray(),
        ]);

        res.send({ parcels, total });
      } catch (err) {
        console.error("Failed to fetch parcels", err);
        res.status(500).send({ error: "Internal server error" });
      }
    });

    // ➕ Add new parcel
    app.post("/parcels", async (req, res) => {
      try {
        const newParcel = req.body;
        if (!newParcel || Object.keys(newParcel).length === 0) {
          return res.status(400).send({ message: "Invalid parcel data" });
        }
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

    // 🧾 Get single parcel by ID
    app.get("/parcels/:id", async (req, res) => {
      try {
        const id = req.params.id;
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(id),
        });
        if (!parcel) {
          return res.status(404).json({ message: "Parcel not found" });
        }
        res.json(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    // ✏️ Update parcel
    app.patch("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        const updatedData = req.body;

        delete updatedData._id;
        delete updatedData.created_by;
        delete updatedData.tracking_id;
        delete updatedData.creation_date;

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: updatedData }
        );

        if (result.matchedCount === 0) {
          return res.status(404).send({ message: "Parcel not found" });
        }

        res.send({ message: "Parcel updated successfully" });
      } catch (error) {
        console.error("❌ Update failed:", error);
        res.status(500).send({ message: "Failed to update parcel" });
      }
    });

    // ❌ Delete parcel
    app.delete("/parcels/:id", async (req, res) => {
      try {
        const parcelId = req.params.id;
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(parcelId),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

    // 🛰️ Add tracking info
    app.post("/tracking", async (req, res) => {
      try {
        const {
          tracking_id,
          parcelId,
          status,
          message,
          updated_by = "",
        } = req.body;

        const trackingInfo = {
          tracking_id,
          parcelId,
          status,
          message,
          updated_by,
          timestamp: new Date(),
        };

        const result = await trackingCollection.insertOne(trackingInfo);
        res.send(result);
      } catch (err) {
        console.error("Failed to add tracking info:", err);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    // 💳 Stripe Payment Intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      try {
        const paymentIntent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });

        res.json({ clientSecret: paymentIntent.client_secret });
      } catch (err) {
        console.error(err.message);
        res.status(500).send({ error: err.message });
      }
    });

    // 💰 Save payment & update parcel
    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        const alreadyPaid = await paymentsCollection.findOne({ transactionId });
        if (alreadyPaid) {
          return res
            .status(409)
            .send({ message: "Duplicate transaction. Already paid." });
        }

        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { delivery_status: "paid", payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });
        }

        const paymentDoc = {
          parcelId,
          email,
          amount,
          paymentMethod,
          transactionId,
          paid_at_string: new Date().toISOString(),
          paid_at: new Date(),
        };

        const paymentResult = await paymentsCollection.insertOne(paymentDoc);

        res.status(201).send({
          message: "Payment recorded and parcel marked as paid",
          insertedId: paymentResult.insertedId,
        });
      } catch (error) {
        console.error("❌ Payment processing failed:", error);
        res.status(500).send({ message: "Failed to record payment" });
      }
    });

    // 📃 Get payment history
    app.get("/payments", async (req, res) => {
      try {
        const userEmail = req.query.email;
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 10;
        const skip = (page - 1) * limit;

        const query = userEmail ? { email: userEmail } : {};

        const data = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 })
          .skip(skip)
          .limit(limit)
          .toArray();

        const total = await paymentsCollection.countDocuments(query);

        res.send({ data, total });
      } catch (error) {
        console.error("❌ Failed to fetch payments:", error);
        res.status(500).send({ message: "Failed to fetch payment history" });
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
