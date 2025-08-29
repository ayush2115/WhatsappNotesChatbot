// Import necessary modules
const express = require('express');
const twilio = require('twilio');
const admin = require('firebase-admin');
const chrono = require('chrono-node');

// --- CONFIGURATION ---
// Load environment variables from Vercel
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.TWILIO_PHONE_NUMBER; // The Twilio WhatsApp sandbox number
const firebaseServiceAccountBase64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;

// Initialize Twilio client
const client = twilio(accountSid, authToken);

// Initialize Firebase Admin SDK
// This needs to be done only once.
if (admin.apps.length === 0) {
    try {
        // Decode the base64 service account key from environment variables
        const serviceAccountJson = Buffer.from(firebaseServiceAccountBase64, 'base64').toString('ascii');
        const serviceAccount = JSON.parse(serviceAccountJson);

        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
    } catch (error) {
        console.error("CRITICAL: Firebase initialization failed. Check your FIREBASE_SERVICE_ACCOUNT_BASE64 environment variable.", error);
    }
}

const db = admin.firestore();
const app = express();
// Twilio sends data as URL encoded, so we need this middleware
app.use(express.urlencoded({ extended: false }));

// --- HELPER FUNCTIONS ---

/**
 * Sends a message via the Twilio API to a specified WhatsApp number.
 * @param {string} to - The recipient's WhatsApp number in the format 'whatsapp:+1...'
 * @param {string} body - The content of the message to send.
 */
async function sendWhatsappMessage(to, body) {
    try {
        await client.messages.create({
            from: twilioPhoneNumber,
            to: to,
            body: body
        });
        console.log(`Message sent to ${to}: "${body}"`);
    } catch (error) {
        console.error(`Failed to send message to ${to}:`, error);
    }
}

// --- API ROUTES ---

// Main webhook for incoming WhatsApp messages from Twilio
app.post('/api/whatsapp', async (req, res) => {
    const incomingMsg = req.body.Body.trim();
    const fromNumber = req.body.From; // User's WhatsApp number (e.g., 'whatsapp:+1... ')
    let replyMsg = '';

    console.log(`Received message from ${fromNumber}: "${incomingMsg}"`);

    try {
        // Command: Set a reminder
        if (incomingMsg.toLowerCase().startsWith('remind me to')) {
            const reminderText = incomingMsg.substring('remind me to'.length).trim();
            const results = chrono.parse(reminderText);

            if (results.length > 0) {
                const reminderDate = results[0].start.date();
                const whatToRemind = reminderText.substring(0, results[0].index).trim();
                
                if (!whatToRemind) {
                    replyMsg = 'I see a time, but what should I remind you about? Please try again in the format: `remind me to [task] at [time]`.';
                } else {
                    const reminder = {
                        from: fromNumber,
                        text: whatToRemind,
                        reminderTime: admin.firestore.Timestamp.fromDate(reminderDate),
                        sent: false,
                        createdAt: admin.firestore.FieldValue.serverTimestamp()
                    };
                    await db.collection('reminders').add(reminder);
                    replyMsg = `✅ Reminder set! I will remind you to "${whatToRemind}" on ${reminderDate.toLocaleString()}.`;
                }
            } else {
                replyMsg = 'I couldn\'t figure out the time for that reminder. Please try being more specific, like "tomorrow at 5pm" or "in 30 minutes".';
            }

        // Command: Search for a note
        } else if (incomingMsg.toLowerCase().startsWith('find') || incomingMsg.toLowerCase().startsWith('search')) {
            const searchTerm = incomingMsg.split(' ').slice(1).join(' ');
            if (!searchTerm) {
                replyMsg = 'What would you like to search for? Please use `find [keyword]`.';
            } else {
                const snapshot = await db.collection('notes').where('from', '==', fromNumber).get();

                if (snapshot.empty) {
                    replyMsg = 'You haven\'t saved any notes yet.';
                } else {
                    const matchingNotes = [];
                    snapshot.forEach(doc => {
                        if (doc.data().text.toLowerCase().includes(searchTerm.toLowerCase())) {
                            matchingNotes.push(`- ${doc.data().text}`);
                        }
                    });

                    if (matchingNotes.length > 0) {
                        replyMsg = `Found ${matchingNotes.length} note(s) matching "${searchTerm}":\n\n${matchingNotes.join('\n')}`;
                    } else {
                        replyMsg = `Couldn't find any notes matching "${searchTerm}".`;
                    }
                }
            }
        // Command: Show all notes
        } else if (incomingMsg.toLowerCase() === 'show all notes') {
            const snapshot = await db.collection('notes').where('from', '==', fromNumber).get();
            if (snapshot.empty) {
                replyMsg = 'You haven\'t saved any notes yet.';
            } else {
                const allNotes = snapshot.docs.map(doc => `- ${doc.data().text}`);
                replyMsg = `Here are all your saved notes:\n\n${allNotes.join('\n')}`;
            }

        // Command: Help
        } else if (incomingMsg.toLowerCase() === 'help') {
             replyMsg = `Welcome to your personal assistant!\n\n*How to Use:*\n\n*1. Save a Note:*\nJust send any message.\n_Example: Remember to buy milk_\n\n*2. Find a Note:*\nStart your message with 'find' or 'search'.\n_Example: find milk_\n\n*3. Set a Reminder:*\nUse the 'remind me' format.\n_Example: remind me to call Jane tomorrow at 10am_`
        
        // Default action: Save a note
        } else {
            const note = {
                from: fromNumber,
                text: incomingMsg,
                createdAt: admin.firestore.FieldValue.serverTimestamp()
            };
            await db.collection('notes').add(note);
            replyMsg = `✅ Note saved: "${incomingMsg}"`;
        }
    } catch (error) {
        console.error("Error processing message:", error);
        replyMsg = "Sorry, something went wrong. Please check the server logs.";
    }

    // Use TwiML to format the response for Twilio
    const twiml = new twilio.twiml.MessagingResponse();
    twiml.message(replyMsg);
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(twiml.toString());
});

// Cron job endpoint for checking and sending reminders
app.get('/api/reminders', async (req, res) => {
    // Vercel's cron jobs can be protected. For this simple app, we don't need it.
    // In a production app, you would add a 'cron secret' to prevent unauthorized access.
    
    const now = admin.firestore.Timestamp.now();
    try {
        const snapshot = await db.collection('reminders')
            .where('sent', '==', false)
            .where('reminderTime', '<=', now)
            .get();

        if (snapshot.empty) {
            console.log('Cron job ran: No reminders were due.');
            return res.status(200).send('No reminders due.');
        }

        const promises = snapshot.docs.map(doc => {
            const reminder = doc.data();
            const message = `🔔 Reminder: ${reminder.text}`;
            return sendWhatsappMessage(reminder.from, message)
                .then(() => doc.ref.update({ sent: true }));
        });
        
        await Promise.all(promises);
        console.log(`Cron job ran: Sent ${snapshot.size} reminders.`);
        res.status(200).send(`Sent ${snapshot.size} reminders.`);

    } catch (error) {
        console.error('Error in cron job while checking reminders:', error);
        res.status(500).send('Error checking reminders.');
    }
});

// Export the Express app for Vercel to use as a serverless function
module.exports = app;

