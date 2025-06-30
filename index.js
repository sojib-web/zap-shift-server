// @ts-nocheck
const express = require("express");
const cors = require("cors");
const dotenv = require("dotenv");
const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config(); // .env থেকে config লোড

const app = express();
const port = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ✅ Stripe ঠিকভাবে initialize করা হচ্ছে
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

    app.get("/parcels", async (req, res) => {
      const email = req.query.email;
      const query = email ? { created_by: email } : {};
      const parcels = await parcelsCollection
        .find(query)
        .sort({ creation_date: -1 })
        .toArray();
      res.send(parcels);
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
      const id = req.params.id;
      try {
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

    // ✅ Stripe payment intent create
    // ✅ POST /create-payment-intent
    app.post("/create-payment-intent", async (req, res) => {
      const { amount } = req.body;

      // 🔐 Validation check
      if (
        !amount ||
        typeof amount !== "number" ||
        isNaN(amount) ||
        amount <= 0
      ) {
        console.error("❌ Invalid amount:", amount);
        return res.status(400).send({ error: "Invalid amount provided" });
      }

      try {
        console.log("✅ Creating payment intent for amount:", amount);

        const paymentIntent = await stripe.paymentIntents.create({
          amount, // amount must be in cents
          currency: "usd",
          payment_method_types: ["card"],
        });

        console.log("✅ PaymentIntent created:", paymentIntent.id);

        res.send({ client_secret: paymentIntent.client_secret });
      } catch (error) {
        console.error("❌ Payment intent creation error:", error.message);
        res.status(500).send({ error: error.message });
      }
    });

    app.post("/payments", async (req, res) => {
      try {
        const { email, parcelId, transactionId, amount, paymentMethod } =
          req.body;

        if (
          !email ||
          !parcelId ||
          !transactionId ||
          !amount ||
          !paymentMethod
        ) {
          return res.status(400).send({ error: "Missing payment data" });
        }

        if (!ObjectId.isValid(parcelId)) {
          return res.status(400).send({ error: "Invalid parcel ID" });
        }

        const paymentDoc = {
          email,
          parcelId,
          transactionId,
          amount,
          paymentMethod,
          paid_at_string: new Date().toISOString(),
          paidAt: new Date(),
        };

        console.log("Saving payment:", paymentDoc);

        const result = await paymentsCollection.insertOne(paymentDoc);

        const updateResult = await parcelsCollection.updateOne(
          { _id: new ObjectId(parcelId) },
          { $set: { payment_status: "paid" } }
        );

        if (updateResult.modifiedCount === 0) {
          return res.status(404).send({ error: "Parcel not found" });
        }

        res.send({
          message: "Payment saved & parcel marked as paid",
          insertedId: result.insertedId,
        });
      } catch (error) {
        console.error("Payment save error:", error);
        res
          .status(500)
          .send({ error: error.message || "Failed to save payment" });
      }
    });

    app.get("/payments", async (req, res) => {
      try {
        const email = req.query.email;
        const query = email ? { email } : {};
        const payments = await paymentsCollection
          .find(query)
          .sort({ paidAt: -1 })
          .toArray();

        res.send(payments);
      } catch (error) {
        console.error("Payment history fetch error:", error);
        res.status(500).send({ error: "Failed to fetch payments" });
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
