// @ts-nocheck
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY);
const path = require("path");

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// Initialize Firebase Admin SDK
const serviceAccount = require(path.join(
  __dirname,
  "config",
  "zap-admin.json"
));
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

// MongoDB connection
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r355ogr.mongodb.net/?retryWrites=true&w=majority`;
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

    // Collections
    const db = client.db("parcelDelivery");
    const usersCollection = db.collection("users");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking_updates");
    const ridersCollection = db.collection("riders");

    // Middlewares
    const verifyFBToken = async (req, res, next) => {
      const authorization = req.headers.authorization;
      if (!authorization)
        return res.status(401).send({ message: "Unauthorized" });

      const token = authorization.split(" ")[1];
      try {
        const decoded = await admin.auth().verifyIdToken(token);
        console.log("Decoded Token:", decoded);
        req.decoded = decoded;
        next();
      } catch (error) {
        console.error("Token verification failed:", error);
        return res.status(401).send({ message: "Unauthorized" });
      }
    };

    const verifyAdmin = async (req, res, next) => {
      const email = req.decoded.email;
      const user = await usersCollection.findOne({ email });
      console.log("User role check:", user?.role);
      if (user?.role !== "admin") {
        return res.status(403).send({ message: "Admins only" });
      }
      next();
    };

    // ===== Routes =====

    // Create user
    app.post("/users", async (req, res) => {
      const { email, ...rest } = req.body;
      if (!email) return res.status(400).send({ message: "Email is required" });
      const lowEmail = email.toLowerCase();
      const existing = await usersCollection.findOne({ email: lowEmail });
      if (existing) return res.send({ message: "User already exists" });
      const result = await usersCollection.insertOne({
        email: lowEmail,
        ...rest,
        role: "user",
      });
      res.send(result);
    });

    // Get role by email
    app.get("/users/role/:email", verifyFBToken, async (req, res) => {
      const emailParam = req.params.email;
      const user = await usersCollection.findOne({
        email: { $regex: `^${emailParam}$`, $options: "i" },
      });
      if (!user)
        return res
          .status(404)
          .send({ success: false, message: "User not found" });
      res.send({ success: true, role: user.role ?? "guest" });
    });

    // Search users
    app.get("/users/search", verifyFBToken, verifyAdmin, async (req, res) => {
      const { email } = req.query;
      if (!email || email.trim().length < 2)
        return res.status(400).send({ message: "Email query param required" });
      const regex = new RegExp(email.trim(), "i");
      const users = await usersCollection
        .find({ email: { $regex: regex } })
        .project({ password: 0 })
        .toArray();
      res.send(users);
    });

    // Update user role
    app.patch(
      "/users/:id/role",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        const { role } = req.body;
        if (!ObjectId.isValid(id))
          return res.status(400).send({ message: "Invalid user ID" });
        if (!["admin", "user", "rider"].includes(role))
          return res.status(400).send({ message: "Invalid role" });

        const result = await usersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { role } }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ message: "User not found" });

        res.send({
          message: `✅ User role updated to "${role}"`,
          modifiedCount: result.modifiedCount,
        });
      }
    );

    // Parcels CRUD
    app.get("/parcels", async (req, res) => {
      const { email, page = 1, limit = 10 } = req.query;
      const skip = (page - 1) * limit;
      const query = email ? { created_by: email } : {};
      const [total, parcels] = await Promise.all([
        parcelsCollection.countDocuments(query),
        parcelsCollection
          .find(query)
          .sort({ creation_date: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray(),
      ]);
      res.send({ parcels, total });
    });

    app.post("/parcels", async (req, res) => {
      const parcel = req.body;
      if (!parcel || Object.keys(parcel).length === 0)
        return res.status(400).send({ message: "Invalid parcel data" });
      const result = await parcelsCollection.insertOne(parcel);
      res.status(201).send({
        message: "Parcel added successfully",
        insertedId: result.insertedId,
      });
    });

    app.get("/parcels/:id", async (req, res) => {
      const parcel = await parcelsCollection.findOne({
        _id: new ObjectId(req.params.id),
      });
      if (!parcel) return res.status(404).send({ message: "Parcel not found" });
      res.send(parcel);
    });

    app.patch("/parcels/:id", async (req, res) => {
      const data = { ...req.body };
      delete data._id;
      delete data.created_by;
      delete data.tracking_id;
      delete data.creation_date;
      const result = await parcelsCollection.updateOne(
        { _id: new ObjectId(req.params.id) },
        { $set: data }
      );
      if (result.matchedCount === 0)
        return res.status(404).send({ message: "Parcel not found" });
      res.send({ message: "Parcel updated successfully" });
    });

    app.delete("/parcels/:id", async (req, res) => {
      const result = await parcelsCollection.deleteOne({
        _id: new ObjectId(req.params.id),
      });
      if (result.deletedCount === 0)
        return res.status(404).send({ message: "Parcel not found" });
      res.send({ message: "Parcel deleted successfully" });
    });

    // Tracking update
    app.post("/tracking", async (req, res) => {
      const {
        tracking_id,
        parcelId,
        status,
        message,
        updated_by = "",
      } = req.body;
      const track = {
        tracking_id,
        parcelId,
        status,
        message,
        updated_by,
        timestamp: new Date(),
      };
      const result = await trackingCollection.insertOne(track);
      res.send(result);
    });

    // Stripe: Create payment intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;
      if (!amount) return res.status(400).send({ message: "Amount required" });
      try {
        const intent = await stripe.paymentIntents.create({
          amount,
          currency: "usd",
          payment_method_types: ["card"],
        });
        res.send({ clientSecret: intent.client_secret });
      } catch (error) {
        res.status(500).send({ message: "Payment intent creation failed" });
      }
    });

    // Example: /payments GET route with query params for pagination and filtering by email
    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const { email, page = 1, limit = 10 } = req.query;
        if (!email)
          return res.status(400).send({ message: "Email is required" });

        const query = { email: email.toLowerCase() };
        const options = {
          skip: (page - 1) * limit,
          limit: parseInt(limit),
          sort: { paid_at: -1 }, // latest payments first
        };

        const total = await paymentsCollection.countDocuments(query);
        const payments = await paymentsCollection
          .find(query, options)
          .toArray();

        res.send({ data: payments, total });
      } catch (error) {
        console.error(error);
        res.status(500).send({ message: "Server error" });
      }
    });

    // Record payment
    app.post("/payments", verifyFBToken, async (req, res) => {
      const { parcelId, email, amount, paymentMethod, transactionId } =
        req.body;
      if (!parcelId || !email || !amount || !paymentMethod || !transactionId)
        return res.status(400).send({ message: "Missing payment data" });
      const dup = await paymentsCollection.findOne({ transactionId });
      if (dup)
        return res
          .status(409)
          .send({ message: "Duplicate transaction. Already paid." });
      const update = await parcelsCollection.updateOne(
        { _id: new ObjectId(parcelId) },
        { $set: { delivery_status: "paid", payment_status: "paid" } }
      );
      if (update.modifiedCount === 0)
        return res
          .status(404)
          .send({ message: "Parcel not found or already paid" });
      const doc = {
        parcelId,
        email,
        amount,
        paymentMethod,
        transactionId,
        paid_at_string: new Date().toISOString(),
        paid_at: new Date(),
      };
      const result = await paymentsCollection.insertOne(doc);
      res.status(201).send({
        message: "Payment recorded and parcel marked as paid",
        insertedId: result.insertedId,
      });
    });

    // Rider: Apply
    app.post("/riders", verifyFBToken, async (req, res) => {
      const rider = { ...req.body, status: "pending", createdAt: new Date() };
      if (!rider.name || !rider.email || !rider.phone)
        return res
          .status(400)
          .send({ message: "Name, email, and phone are required." });
      const result = await ridersCollection.insertOne(rider);
      res.status(201).send({
        message: "Rider application submitted successfully",
        insertedId: result.insertedId,
      });
    });

    // Rider: Pending list (admin only)
    app.get("/riders/pending", verifyFBToken, verifyAdmin, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .toArray();
        res.send(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res.status(500).send({ message: "Internal Server Error" });
      }
    });

    app.get(
      "/riders/approved",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        try {
          console.log("👉 req.user:", req.user);

          const approvedRiders = await ridersCollection
            .find({ status: "active" })
            .toArray();

          console.log("✅ Approved Riders found:", approvedRiders.length);
          res.send(approvedRiders);
        } catch (error) {
          console.error("❌ Error in /riders/approved route:", error.message);
          res.status(500).send({ error: "Server error occurred" });
        }
      }
    );

    // Rider: Get by ID
    app.get("/riders/:id", async (req, res) => {
      const id = req.params.id;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID" });
      const rider = await ridersCollection.findOne({ _id: new ObjectId(id) });
      if (!rider) return res.status(404).send({ message: "Rider not found" });
      res.send(rider);
    });

    // Rider: Update status
    app.patch(
      "/riders/status/:id",
      verifyFBToken,
      verifyAdmin,
      async (req, res) => {
        const { id } = req.params;
        if (!ObjectId.isValid(id))
          return res.status(400).send({ message: "Invalid rider ID" });
        const { status, email } = req.body;
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );
        if (result.matchedCount === 0)
          return res.status(404).send({ message: "Rider not found" });
        if (status === "active" && email)
          await usersCollection.updateOne(
            { email: email.toLowerCase() },
            { $set: { role: "rider" } }
          );
        res.send({
          message: `Rider status updated to ${status}`,
          modifiedCount: result.modifiedCount,
        });
      }
    );

    // Rider: Delete
    app.delete("/riders/:id", verifyFBToken, verifyAdmin, async (req, res) => {
      const { id } = req.params;
      if (!ObjectId.isValid(id))
        return res.status(400).send({ message: "Invalid ID" });
      const result = await ridersCollection.deleteOne({
        _id: new ObjectId(id),
      });
      if (result.deletedCount === 0)
        return res.status(404).send({ message: "Rider not found" });
      res.send({ message: "Rider rejected and deleted successfully" });
    });

    console.log("🛠️ All routes are set");
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
  }
}

run().catch(console.dir);

app.get("/", (req, res) => res.send("📦 Parcel Delivery API is running"));
app.listen(port, () => console.log(`🚀 Server is running on port ${port}`));
