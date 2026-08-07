const express = require("express");

const app = express();

app.use(express.json());

app.get("/", (req, res) => {
    res.json({
        service: "Skout AI Email Verification",
        version: "1.0.0",
        status: "running"
    });
});

app.listen(3000, () => {
    console.log("================================");
    console.log("Skout Email Verification API");
    console.log("Running on http://localhost:3000");
    console.log("================================");
});