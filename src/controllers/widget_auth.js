import jwt from "jsonwebtoken";
import dotenv from "dotenv";   
import express from "express";
const app = express();

app.use(express.json()); 

dotenv.config();

export function generateZendeskJWT(req, res) {
    const user = req.body; // Assuming user details are sent in the request body;
    console.log("Received request to generate JWT with user details:", user);
    console.log("Generating JWT for user:", user);
    
  const token = jwt.sign(
    {
      scope: "user",
      external_id: user?.id,
      name: user?.name || 'UNKNOWN',
      email: user?.email || 'UNKNOWN@example.com',
      email_verified: true
    },
    'YC7Jj9UuFGGHLaADK003LEDfm7FkvBoMaRPhRfVMpm8zuV7lV5BHsFjarhtZUoPGilxnWZdvs-_MkcPVuWbiLQ',
    { 
      algorithm: "HS256",
      expiresIn: "5m",
      keyid: 'app_6a157e3ede3d22ed4f33babe'
    }
  );
  res.json({token});
}