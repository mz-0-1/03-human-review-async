import express, { Request, Response, RequestHandler } from "express";
import { config } from "dotenv";
import mysql from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";
import cors from "cors";

// humanlayer imports
import { HumanLayer } from "humanlayer";
// classification logic imports
import {
  classifyEmail,
  classificationValues,
  ClassifiedEmail,
  logEmails,
  twoEmailsShuffled,
  Classification,
} from "./common";

config(); // Loads .env
const app = express();

// Setup CORS (for dev only; restrict in production)
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

// Parse JSON body
app.use(express.json());

// Setup MySQL connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// Initialize HumanLayer
const hl = new HumanLayer({
  verbose: true,
  runId: "email-classifier-webhook",
});

// SSE clients
const sseClients: Array<express.Response> = [];

/** 
 * 1) HELPER FUNCTION: Store new email classification in DB 
 */
async function storeEmailClassification(
  callId: string,
  email: any,
  aiClassification: string
): Promise<void> {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      `INSERT INTO email_classifications 
         (id, subject, body, email_to, email_from, classification, status, has_human_review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        callId,
        email.subject,
        email.body,
        email.to,
        email.from,
        aiClassification,
        "pending",      // newly created -> pending
        false,          // no human review yet
      ]
    );
    console.log(`Inserted record with call_id: ${callId}`);
  } finally {
    connection.release();
  }
}

/**
 * 2) HELPER FUNCTION: Update classification with human review
 */
async function updateWithHumanReview(
  callId: string,
  humanClassification: Classification,
  humanComment: string
) {
  const connection = await pool.getConnection();
  try {
    const [result] = await connection.query(
      `UPDATE email_classifications
         SET human_classification = ?,
             human_comment = ?,
             status = 'completed',
             has_human_review = true,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      [humanClassification, humanComment, callId]
    );

    const updateResult = result as any;
    if (updateResult.affectedRows === 0) {
      console.error(`No record found for ID: ${callId}`);
    } else {
      console.log(`Successfully updated record for ID: ${callId}`);

      // Broadcast SSE update
      const updatePayload = {
        type: "update",
        callId,
        humanClassification,
        humanComment,
        timestamp: new Date().toISOString(),
      };
      broadcastSseEvent(updatePayload);
    }
  } catch (error) {
    console.error("Failed updating record:", error);
  } finally {
    connection.release();
  }
}

/** 
 * 3) HELPER FUNCTION: Broadcast SSE to all connected clients 
 */
function broadcastSseEvent(data: any) {
  sseClients.forEach((clientRes) => {
    clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

/**
 * 4) HELPER FUNCTION: Fetch all classifications
 */
async function fetchAllClassifications(): Promise<ClassifiedEmail[]> {
  const connection = await pool.getConnection();
  try {
    const [rows] = await connection.query(`
      SELECT
        id,
        subject,
        body,
        email_to AS \`to\`,
        email_from AS \`from\`,
        classification,
        human_classification AS humanClassification,
        human_comment AS humanComment,
        has_human_review AS hasHumanReview,
        status,
        created_at,
        updated_at
      FROM email_classifications
    `);
    return rows as ClassifiedEmail[];
  } finally {
    connection.release();
  }
}

/**
 * 5) ENDPOINT:  POST /process 
 *    - classify emails with AI
 *    - store them in DB (status='pending')
 *    - create HL function calls with same call_id
 */
async function processEmails() {
  console.log("\nStarting email classification process...\n");

  // Loop through your sample emails
  for (const email of twoEmailsShuffled) {
    // Generate a unique call_id
    const callId = `call-${uuidv4().split("-")[0]}`;

    // AI classification logic
    const aiClassification = await classifyEmail(email);

    // Store in DB with 'pending'
    await storeEmailClassification(callId, email, aiClassification);

    // Create a HumanLayer function call using SAME callId
    await hl.createFunctionCall({
      spec: {
        fn: "classifyEmail",
        kwargs: {
          to: email.to,
          from: email.from,
          subject: email.subject,
          body: email.body,
          classification: aiClassification,
          call_id: callId, // <--- same ID
        },
        // build reject_options from classificationValues
        reject_options: classificationValues
          .filter((c) => c !== aiClassification)
          .map((c) => ({
            name: c,
            title: c,
            description: `Classify as ${c}`,
            prompt_fill: `manual classify: ${c}`,
            interactive: false,
          })),
      },
    });
    console.log(`Created HL function call with callId: ${callId}`);
  }
}

async function processHandler(req: Request, res: Response) {
  try {
    await processEmails();
    res.json({ status: "Processing completed successfully" });
  } catch (error) {
    console.error("Error processing emails:", error);
    res.status(500).json({ error: String(error) });
  }
}

/**
 * 6) ENDPOINT:  POST /webhook 
 *    - Called by HL when user approves or modifies classification
 *    - We update DB row from 'pending' to 'completed'
 */
const webhookHandler: RequestHandler = async (req, res): Promise<void> => {
  try {
    console.log("=== Webhook received ===");
    console.log("Headers:", req.headers);
    console.log("Body:", JSON.stringify(req.body, null, 2));

    const webhook = req.body;
    if (!webhook.spec?.kwargs) {
      return void res
        .status(400)
        .json({ error: "Invalid webhook structure: missing spec.kwargs" });
    }

    const callId = webhook.spec.kwargs.call_id;
    if (!callId) {
      return void res
        .status(400)
        .json({ error: "Missing call_id in webhook" });
    }

    // Double-check record in DB
    const connection = await pool.getConnection();
    let recordStatus: string | undefined;
    try {
      const [rows] = await connection.query(
        "SELECT status FROM email_classifications WHERE id = ?",
        [callId]
      );
      recordStatus = (rows as any[])[0]?.status;
    } finally {
      connection.release();
    }

    if (!recordStatus) {
      console.log(`No record found for ID: ${callId}`);
      return void res.json({ status: "no record found" });
    } else if (recordStatus === "completed") {
      console.log(`Classification already completed for ID: ${callId}`);
      return void res.json({ status: "already processed" });
    }

    // Figure out if it was approved or manually classified
    let humanClassification: Classification | null = null;
    if (webhook.status?.approved) {
      // HL's "approved" means the user picked the original suggestion
      humanClassification = webhook.spec.kwargs.classification;
    } else if (webhook.status?.comment?.includes("manual classify:")) {
      // If the user typed a manual classification in a comment
      humanClassification = webhook.status.comment.replace(
        "manual classify: ",
        ""
      ) as Classification;
    }

    // Default fallback if we can't parse
    if (!humanClassification) {
      humanClassification = "read";
    }

    // Update DB
    await updateWithHumanReview(callId, humanClassification, webhook.status?.comment || "");

    // Show final logs
    const allClassifications = await fetchAllClassifications();
    logEmails(allClassifications);

    res.json({ status: "ok" });
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ error: String(error) });
  }
};

/**
 * 7) ENDPOINT: GET /sse
 *    - Opens SSE connection, sends "test" + "initialData", then streams updates
 */
app.get("/sse", async (req, res) => {
  console.log("=== SSE Connection Start ===");

  // SSE headers
  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Access-Control-Allow-Origin": "*",
  });
  // flush headers (for some frameworks/environments, not always needed)
  res.flushHeaders?.(); 
  console.log("Headers set and flushed");

  // Track the SSE client
  sseClients.push(res);
  console.log(`Client added. Total clients: ${sseClients.length}`);

  // Send test message
  console.log("Sending test message");
  res.write(`data: ${JSON.stringify({ type: "test", message: "SSE Connected" })}\n\n`);

  try {
    console.log("Attempting database connection");
    const connection = await pool.getConnection();
    try {
      console.log("Running database query");
      const [rows] = await connection.query(`
        SELECT
          id,
          subject,
          body,
          email_to AS \`to\`,
          email_from AS \`from\`,
          classification,
          human_classification AS humanClassification,
          human_comment AS humanComment,
          has_human_review AS hasHumanReview,
          status,
          created_at,
          updated_at
        FROM email_classifications
      `);

      console.log(`Query complete. Found ${(rows as any[]).length} records`);

      // Send initial data
      const initialData = { initialData: rows };
      const dataString = JSON.stringify(initialData);
      console.log(`Preparing to send ${dataString.length} bytes of data`);

      res.write(`data: ${dataString}\n\n`);
      console.log("Initial data sent");
    } finally {
      connection.release();
      console.log("Database connection released");
    }
  } catch (error) {
    console.error("Database error:", error);
    res.write(`data: ${JSON.stringify({ error: "Failed to load initial data" })}\n\n`);
  }

  // Heartbeat to keep connection alive
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(": heartbeat\n\n");
    }
  }, 30000);

  // Cleanup on client disconnect
  req.on("close", () => {
    clearInterval(heartbeat);
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
      console.log("=== Client disconnected ===");
      console.log(`Remaining clients: ${sseClients.length}`);
    }
  });
});

/** 8) Register routes */
app.post("/webhook", webhookHandler);
app.post("/process", processHandler);

/** 9) Start server */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
