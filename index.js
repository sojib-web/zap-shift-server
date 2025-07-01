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

    // ✅ Create Stripe Payment Intent
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

    // Save Payment
    // app.post("/payments", async (req, res) => {
    //   const { email, parcelId, transactionId, amount, paymentMethod } =
    //     req.body;
    //   if (!email || !parcelId || !transactionId || !amount || !paymentMethod) {
    //     return res.status(400).send({ error: "Missing fields" });
    //   }

    //   const paymentDoc = {
    //     email,
    //     parcelId,
    //     transactionId,
    //     amount,
    //     paymentMethod,
    //     paidAt: new Date(),
    //   };

    //   const result = await paymentsCollection.insertOne(paymentDoc);

    //   await parcelsCollection.updateOne(
    //     { _id: new ObjectId(parcelId) },
    //     { $set: { payment_status: "paid" } }
    //   );

    //   res.send({ message: "Payment recorded", insertedId: result.insertedId });
    // });

    // Get Payments
    // app.get("/payments", async (req, res) => {
    //   const email = req.query.email;
    //   const result = await paymentsCollection
    //     .find(email ? { email } : {})
    //     .sort({ paidAt: -1 })
    //     .toArray();
    //   res.send(result);
    // });
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
