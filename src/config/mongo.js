import mongoose from "mongoose";

export const connectDB = async () => {
    try {
        await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/webwidgetbot");

        console.log("MongoDB Connected");
    } catch (error) {
        console.error("MongoDB Connection Error:", error);
        process.exit(1);
    }
};

const reportSchema = new mongoose.Schema(
    {
        id: {
            type: String,
            required: true,
        },
        score: {
            type: String,
            required: true,
        }
    },
    {
        timestamps: true,
    }
);

export const REPORT = mongoose.model("REPORT", reportSchema);