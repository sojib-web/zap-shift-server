// @ts-nocheck
const dotenv = require("dotenv");
dotenv.config(); // ✅ Load environment variables before anything else

const express = require("express");
const cors = require("cors");
const admin = require("firebase-admin");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const stripe = require("stripe")(process.env.PAYMENT_GATEWAY_KEY); // ✅ Stripe key is now properly loaded

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const serviceAccount = JSON.parse(process.env.FIREBASE_ADMIN_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.r355ogr.mongodb.net/?retryWrites=true&w=majority&appName=Cluster0`;

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const verifyFBToken = async (req, res, next) => {
  const header = req.headers.authorization;
  if (!header) return res.status(401).send({ message: "Unauthorized access" });

  const token = header.split(" ")[1];
  if (!token) return res.status(401).send({ message: "Unauthorized access" });

  try {
    const decodedToken = await admin.auth().verifyIdToken(token);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error("❌ Token verification failed:", error);
    return res.status(403).send({ message: "Forbidden access" });
  }
};

async function run() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");

    const db = client.db("parcelDelivery");
    const parcelsCollection = db.collection("parcels");
    const paymentsCollection = db.collection("payments");
    const trackingCollection = db.collection("tracking_updates");
    const usersCollection = db.collection("users");
    const ridersCollection = db.collection("riders");
    // ========== ROUTES ==========

    app.post("/users", async (req, res) => {
      try {
        const user = req.body;
        if (!user?.email || !user?.name || !user?.photo) {
          return res.status(400).send({ message: "Invalid user data" });
        }

        const existingUser = await usersCollection.findOne({
          email: user.email,
        });
        if (existingUser) {
          return res.status(409).send({ message: "User already exists" });
        }

        const newUser = {
          name: user.name,
          email: user.email,
          photo: user.photo,
          role: user.role || "user",
          createdAt: new Date().toISOString(),
          last_log_in: new Date().toISOString(),
        };

        const result = await usersCollection.insertOne(newUser);
        res.status(201).send({
          message: "User registered successfully",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("❌ Failed to register user:", error);
        res.status(500).send({ message: "Failed to register user" });
      }
    });

    app.get("/parcels", verifyFBToken, async (req, res) => {
      try {
        const { email, page = 1, limit = 10 } = req.query;
        const skip = (parseInt(page) - 1) * parseInt(limit);
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
      } catch (err) {
        console.error("Failed to fetch parcels", err);
        res.status(500).send({ error: "Internal server error" });
      }
    });

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

    app.get("/parcels/:id", async (req, res) => {
      try {
        const parcel = await parcelsCollection.findOne({
          _id: new ObjectId(req.params.id),
        });
        if (!parcel)
          return res.status(404).json({ message: "Parcel not found" });
        res.json(parcel);
      } catch (error) {
        console.error("Error fetching parcel:", error);
        res.status(500).json({ message: "Server error" });
      }
    });

    app.patch("/parcels/:id", async (req, res) => {
      try {
        const updatedData = req.body;
        delete updatedData._id;
        delete updatedData.created_by;
        delete updatedData.tracking_id;
        delete updatedData.creation_date;

        const result = await parcelsCollection.updateOne(
          { _id: new ObjectId(req.params.id) },
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

    app.delete("/parcels/:id", async (req, res) => {
      try {
        const result = await parcelsCollection.deleteOne({
          _id: new ObjectId(req.params.id),
        });
        res.send(result);
      } catch (error) {
        console.error("Error deleting parcel:", error);
        res.status(500).send({ message: "Internal server error" });
      }
    });

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

    app.post("/create-payment-intent", async (req, res) => {
      try {
        const { amount } = req.body;
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

    app.post("/payments", async (req, res) => {
      try {
        const { parcelId, email, amount, paymentMethod, transactionId } =
          req.body;

        const alreadyPaid = await paymentsCollection.findOne({ transactionId });
        if (alreadyPaid)
          return res
            .status(409)
            .send({ message: "Duplicate transaction. Already paid." });

        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { delivery_status: "paid", payment_status: "paid" } }
        );
        if (updateResult.modifiedCount === 0)
          return res
            .status(404)
            .send({ message: "Parcel not found or already paid" });

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

    app.get("/payments", verifyFBToken, async (req, res) => {
      try {
        const { email, page = 1, limit = 10 } = req.query;
        console.log("decoded token:", req.user); // ✅ fixed

        if (req.user.email !== email) {
          return res.status(403).send({ message: "Forbidden access" });
        }

        const skip = (parseInt(page) - 1) * parseInt(limit);
        const query = { email }; // ✅ no need for conditional, already validated

        const data = await paymentsCollection
          .find(query)
          .sort({ paid_at: -1 })
          .skip(skip)
          .limit(parseInt(limit))
          .toArray();
        const total = await paymentsCollection.countDocuments(query);

        res.send({ data, total });
      } catch (error) {
        console.error("❌ Failed to fetch payments:", error);
        res.status(500).send({ message: "Failed to fetch payment history" });
      }
    });

    // ✅ Create a new rider (no token required)
    app.post("/riders", async (req, res) => {
      const rider = {
        ...req.body,
        status: "pending",
        createdAt: new Date(),
      };

      try {
        const result = await ridersCollection.insertOne(rider);
        res.status(201).json(result);
      } catch (error) {
        console.error("Insert error:", error);
        res.status(500).json({ message: "Failed to create rider" });
      }
    });

    // ✅ Get all pending riders (sorted by newest)
    app.get("/riders/pending", verifyFBToken, async (req, res) => {
      try {
        const pendingRiders = await ridersCollection
          .find({ status: "pending" })
          .sort({ createdAt: -1 })
          .toArray();

        res.status(200).json(pendingRiders);
      } catch (error) {
        console.error("Error fetching pending riders:", error);
        res.status(500).json({ message: "Server Error" });
      }
    });

    // ✅ Get all approved riders
    app.get("/riders/approved", verifyFBToken, async (req, res) => {
      try {
        const result = await ridersCollection
          .find({ status: "active" })
          .toArray();

        res.status(200).json(result);
      } catch (error) {
        console.error("Error fetching approved riders:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });
    // Update rider status (approve, deactivate, etc.)
    app.patch("/riders/status/:id", async (req, res) => {
      const id = req.params.id;
      const { status } = req.body;

      try {
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Rider not found" });
        }

        res.status(200).json({ message: `Rider status updated to ${status}` });
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ Update rider status (approve, activate, deactivate) + assign role
    app.patch("/riders/status/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;
      const { status, email } = req.body;

      try {
        const result = await ridersCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: { status } }
        );

        if (result.matchedCount === 0) {
          return res.status(404).json({ message: "Rider not found" });
        }

        // Assign rider role if activated
        if (status === "active" && email) {
          const roleResult = await usersCollection.updateOne(
            { email },
            { $set: { role: "rider" } }
          );
          console.log("User role updated:", roleResult.modifiedCount);
        }

        res.status(200).json({ message: `Rider status updated to ${status}` });
      } catch (error) {
        console.error("Error updating rider status:", error);
        res.status(500).json({ message: "Internal server error" });
      }
    });

    // ✅ Delete a rider (rejection)
    app.delete("/riders/:id", verifyFBToken, async (req, res) => {
      const id = req.params.id;

      try {
        const result = await ridersCollection.deleteOne({
          _id: new ObjectId(id),
        });

        if (result.deletedCount === 0) {
          return res.status(404).json({ message: "Rider not found" });
        }

        console.log(`Rider with ID ${id} has been rejected and deleted.`);
        res
          .status(200)
          .json({ message: "Rider rejected and deleted successfully" });
      } catch (error) {
        console.error("Error rejecting rider:", error);
        res.status(500).json({ message: "Internal server error" });
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
