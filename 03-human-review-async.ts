import express, {Request, Response, RequestHandler, Router} from 'express';
import { HumanLayer, FunctionCall, ResponseOption } from "humanlayer";
import { config } from "dotenv";
import mysql from 'mysql2/promise';
import {
  Classification,
  classificationValues,
  classifyEmail,
  twoEmailsShuffled,
  logEmails,
  ClassifiedEmail
} from "./common";
import { v4 as uuidv4 } from 'uuid';
import cors from 'cors';

const app = express();

// Allow all origins with '*' - USE ONLY FOR TESTING PRODUCTION CLIENTS
app.use(cors({
  origin: '*', // replace with https://your-secure-frontend.app
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

app.use(express.json());

config();

// MySQL connection
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
});

// HumanLayer Setup
const hl = new HumanLayer({
  verbose: true,
  runId: "email-classifier-webhook",
});

// Global array to hold active SSE response objects.
const sseClients: Array<express.Response> = [];

/// *** HELPER FUNCTIONS START HERE *** ///

const webhookHandler: RequestHandler = async (req, res): Promise<void> => {
    try {
      console.log('=== Webhook received ===');
      console.log('Headers:', req.headers);
      console.log('Body:', JSON.stringify(req.body, null, 2));
      const webhook = req.body;
  
      // Log the entire payload for debugging
      console.log('Received webhook payload:', JSON.stringify(webhook, null, 2));
  
      // Check the structure
      if (!webhook.spec?.kwargs) {
        console.error('Invalid webhook structure:', webhook);
        res.status(400).json({
          error: 'Invalid webhook structure',
          details: 'Missing spec.kwargs',
        });
        return;  
      }
  
      const callId = webhook.spec.kwargs.call_id;
      if (!callId) {
        console.error('Missing call_id in kwargs:', webhook.spec.kwargs);
        res.status(400).json({
          error: 'Missing call_id',
          details: 'call_id not found in kwargs',
        });
        return;  
      }
  
      // check if the record already exists or is completed
      const connection = await pool.getConnection();
      try {
        const [rows] = await connection.query(
          'SELECT status FROM email_classifications WHERE id = ?',
          [callId]
        );
        const recordStatus = (rows as any[])[0]?.status;
  
        if (!recordStatus) {
          // The DB has no record for this ID
          console.log(`No record found for ID: ${callId} (likely old run or unknown)`);
          res.json({ status: 'no record found' });
          return;
        } else if (recordStatus === 'completed') {
          // Already processed
          console.log(`Classification already completed for ID: ${callId}`);
          res.json({ status: 'already processed' });
          return; 
        }
      } finally {
        connection.release();
      }
  
      // Identify the human classification from the webhook
      let humanClassification: Classification | null = null;
      if (webhook.status?.approved && webhook.spec.kwargs) {
        humanClassification = webhook.spec.kwargs.classification;
      } else if (webhook.status?.comment?.includes('manual classify:')) {
        // If the reviewer typed a manual classification in a comment
        humanClassification = webhook.status.comment.replace('manual classify: ', '') as Classification;
      }
  
      // Update the DB with the human classification
      await updateWithHumanReview(
        callId,
        humanClassification || 'read',      
        webhook.status?.comment || ''
      );

      // Now, fetch the updated classifications and log the results
      const allClassifications = await fetchAllClassifications();
      logEmails(allClassifications);
  
      // If everything works, send final response
      res.json({ status: 'ok' });
      return;
    } catch (error) {
      console.error('Webhook processing error:', error);
      res.status(500).json({ error: String(error) });
      return;
    }
  };
  

async function fetchAllClassifications(): Promise<ClassifiedEmail[]> {
    const connection = await pool.getConnection(); // ensure pool is imported or available here
    try {
        const [rows] = await connection.query(`SELECT 
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
      FROM email_classifications`);
        // Convert rows (if needed) to match ClassifiedEmail
        return rows as ClassifiedEmail[];
    } finally {
        connection.release();
    }
    }
  
  

// Function to store email classification in MySQL
async function storeEmailClassification(
  callId: string,
  email: any,
  aiClassification: string
) {
  const connection = await pool.getConnection();
  try {
    await connection.query(
      `INSERT INTO email_classifications 
       (id, subject, body, email_to, email_from, classification, status, has_human_review)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [callId, email.subject, email.body, email.to, email.from, aiClassification, 'pending', false]
    );
  } finally {
    connection.release();
  }
}


// Function to update classification with human review
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
        // Construct the update payload.
        const updatePayload = {
          type: 'update',
          callId,
          humanClassification,
          humanComment,
          timestamp: new Date().toISOString()
        };
  
        // Broadcast to all connected SSE clients.
        broadcastSseEvent(updatePayload);
      }
    } catch (error) {
      console.error("Failed updating record:", error);
    } finally {
      connection.release();
    }
  }



async function processEmails() {
    try {
      console.log("\nStarting email classification process...\n");
  
      for (const email of twoEmailsShuffled) {
        const callId = `call-${uuidv4().split('-')[0]}`; // Generate ID
        const classification = await classifyEmail(email);
        
        // Log the ID we're using for debugging
        //console.log(`Using call_id: ${callId}`);
        
        await storeEmailClassification(callId, email, classification);
        // Log the ID we're storing for debugging
        //console.log(`Stored in database with ID: ${callId}`);
  
        await hl.createFunctionCall({
          spec: {
            fn: "classifyEmail",
            kwargs: { 
              to: email.to, 
              from: email.from, 
              subject: email.subject, 
              body: email.body, 
              classification,
              call_id: callId  
            },
            reject_options: classificationValues
              .filter(c => c !== classification)
              .map(c => ({
                name: c,
                title: c,
                description: `Classify as ${c}`,
                prompt_fill: `manual classify: ${c}`,
                interactive: false,
              })),
          },
        });
      }
    } catch (error) {
      console.error("Error:", error);
    }
  }

async function processHandler(req: Request, res: Response) {
  try {
    await processEmails();
    res.json({ status: 'Processing completed successfully' });
    return;
  } catch (error) {
    console.error("Error processing emails:", error);
    res.status(500).json({ error: String(error) });
    return;
  }
}

function broadcastSseEvent(data: any) {
  sseClients.forEach((clientRes) => {
    // Format the data according to SSE protocol
    clientRes.write(`data: ${JSON.stringify(data)}\n\n`);
  });
}

/// *** HELPER FUNCTIONS FINISH HERE *** ///

app.post('/webhook', webhookHandler);
app.post('/process', processHandler as RequestHandler);

app.get('/sse', async (req, res) => {
  console.log('New SSE connection requested');
  
  // Set SSE headers
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*'
  });
  res.flushHeaders();

  // Add to clients list first
  sseClients.push(res);
  console.log('Added client. Total clients:', sseClients.length);

  // Send immediate test message
  res.write(`data: ${JSON.stringify({ type: 'test', message: 'SSE Connected' })}\n\n`);

  // Retry database connection a few times
  let retries = 3;
  while (retries > 0) {
    try {
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
        console.log(`Sending initial data: ${(rows as any[]).length} records`);
        
        // Break data into smaller chunks if needed
        const data = JSON.stringify({ initialData: rows });
        res.write(`data: ${data}\n\n`);
        
        break; // Success, exit retry loop
      } finally {
        connection.release();
      }
    } catch (error) {
      console.error(`Database connection attempt ${4-retries} failed:`, error);
      retries--;
      if (retries === 0) {
        res.write(`data: ${JSON.stringify({ error: 'Failed to load initial data' })}\n\n`);
      } else {
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait 1s before retry
      }
    }
  }

  // Keep connection alive with heartbeat
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 30000);

  // Handle client disconnect
  req.on('close', () => {
    clearInterval(heartbeat);
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
      console.log('Client disconnected. Remaining clients:', sseClients.length);
    }
  });
});

// Server startup
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});