require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const SibApiV3Sdk = require('sib-api-v3-sdk');
const multer = require('multer');
const path = require('path');
const cors = require('cors');

// 🤖 Google Generative AI
const { GoogleGenerativeAI } = require("@google/generative-ai");

// ☁️ Cloudinary Configuration for Permanent Storage
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');

const app = express();
const PORT = process.env.PORT || 3001;

// --- API Configurations ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// --- Middleware ---
app.use(express.json());
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// --- Cloudinary Multer Storage ---
const storage = new CloudinaryStorage({
  cloudinary: cloudinary,
  params: {
    folder: 'evidence_uploads', 
    allowed_formats: ['jpg', 'png', 'jpeg', 'webp']
  },
});

const upload = multer({ storage: storage });

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- Schemas & Models ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String }, 
    password: { type: String }, 
    role: { type: String, default: 'citizen' }, 
    status: { type: String, default: 'active' }, 
    authMethod: { type: String, default: 'local' },
    otp: String,
    otpExpires: Date,
    // 🚩 3-Strike System Counter
    strikes: { type: Number, default: 0 }
});

const complaintSchema = new mongoose.Schema({
    trackingId: String,
    citizenName: String,
    barangay: String,
    category: String,
    description: String,
    imageUrl: String,
    status: { type: String, default: 'Pending' },
    priority: { type: String, default: 'MEDIUM' }, // 🚩 NEW: Priority field
    lguNote: String,
    // 📊 Audit Trail Array
    history: [{
        status: String,
        note: String,
        updatedBy: String,
        updatedAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- AI IMAGE MODERATOR LOGIC (UPGRADED) ---
async function scanImageWithAI(imageUrl, category) {
    try {
        const response = await fetch(imageUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

        // 🧠 The AI now checks if the photo matches the exact category chosen by the user
        const prompt = `You are a strict content moderator for a city complaint system.
        The citizen claims this image is evidence of a "${category}". Does the image explicitly show a ${category}?
        Answer strictly with one word: YES or NO.`;

        const imagePart = {
            inlineData: {
                data: buffer.toString("base64"),
                mimeType: response.headers.get("content-type") || "image/jpeg"
            }
        };

        const result = await model.generateContent([prompt, imagePart]);
        const text = result.response.text().trim().toUpperCase();
        
        console.log(`🤖 AI Scan Result for [${category}]: ${text}`);
        return text.includes("YES");

    } catch (error) {
        console.error("AI Scan Error:", error);
        return true; // Fallback to true so we don't accidentally block real complaints if AI fails
    }
}

// --- AI SENTIMENT & PRIORITY ANALYZER ---
async function analyzePriority(category, description) {
    try {
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });
        
        const prompt = `
            You are an emergency dispatcher AI for a local government. 
            Analyze the following citizen complaint based on its category and description.
            Determine the urgency and priority level based on sentiment, potential danger, and community impact.

            Category: "${category}"
            Description: "${description}"

            Respond ONLY with a valid JSON object in this exact format, with no markdown formatting or extra text:
            {
                "priority": "CRITICAL" | "HIGH" | "MEDIUM" | "LOW",
                "reason": "Short 1-sentence explanation why."
            }
        `;

        const result = await model.generateContent(prompt);
        const text = result.response.text().trim();
        
        // Clean up formatting in case AI adds markdown
        const cleanJson = text.replace(/```json|```/g, '').trim();
        const parsedResult = JSON.parse(cleanJson);
        
        console.log(`📊 AI Priority Scan: ${parsedResult.priority} - ${parsedResult.reason}`);
        return parsedResult.priority;
    } catch (error) {
        console.error("AI Priority Scan Error:", error);
        return "MEDIUM"; // Fallback kung pumalya ang AI
    }
}

// --- SEED SUPERADMIN ---
async function seedAdmin() {
    const admin = await User.findOne({ username: 'cityhall' });
    if (!admin) {
        await User.create({ username: 'cityhall', password: 'masterkey2026', role: 'superadmin', authMethod: 'local' });
        console.log("✅ SuperAdmin 'cityhall' created.");
    }
}
seedAdmin();

// --- Brevo Configuration ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();


// --- 1. CITIZEN OTP LOGIN ---
app.post('/api/request-otp', async (req, res) => {
    const { email, username, password } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        let user = await User.findOne({ email });
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Account is suspended.' });
           
            if (user.authMethod === 'google') return res.status(400).json({ message: 'Registered via Google.' });
            if (user.authMethod === 'local' && !user.otp) return res.status(400).json({ message: 'Email already in use.' });
        }
        if (!user) user = new User({ username: username || email.split('@')[0], email, password, role: 'citizen', authMethod: 'local' });
        user.otp = otp;
        user.otpExpires = new Date(Date.now() + 10 * 60000);
       
        await user.save();
   
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.sender = { "name": "System Admin", "email": "kalappscc@gmail.com" };
        sendSmtpEmail.to = [{ "email": email }];
        sendSmtpEmail.subject = "Your Verification Code";
        sendSmtpEmail.htmlContent = `<h2>Code: ${otp}</h2>`;
        await tranEmailApi.sendTransacEmail(sendSmtpEmail);
        
        res.json({ message: 'OTP sent!' });
    } catch (error) { res.status(500).json({ message: 'Failed to send OTP.' }); }
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });
    if (user) {
        user.otp = undefined; user.otpExpires = undefined;
        await user.save();
        res.json({ message: 'Login successful!', username: user.username, role: user.role });
    } else { res.status(400).json({ message: 'Invalid OTP.' }); }
});

// --- 2. GOOGLE LOGIN ---
app.post('/api/google-login', async (req, res) => {
    const { email, name } = req.body;
    try {
        let user = await User.findOne({ email });
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Suspended.' });
            if (user.authMethod !== 'google') return res.status(400).json({ message: 'Use OTP Login.' });
         
            return res.json({ success: true, username: user.username, role: user.role });
        }
        user = new User({ username: name, email: email, role: 'citizen', authMethod: 'google' });
        await user.save();
        res.json({ success: true, username: user.username, role: user.role });
    } catch (error) { res.status(500).json({ message: 'Google login failed.' }); }
});

// --- 3. LGU/ADMIN LOGIN ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    if (user) {
        if (user.status === 'blocked') return res.status(403).json({ message: "Account suspended due to multiple policy violations." });
        res.json({ success: true, username: user.username, role: user.role });
    } else { res.status(401).json({ message: "Invalid credentials." }); }
});

// --- 4. COMPLAINTS SYSTEM (Upgraded with AI Bouncer & AI Priority) ---
app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description } = req.body;
        const imageUrl = req.file ? req.file.path : '';

        // 1. Check if user is already blocked
        const user = await User.findOne({ username });
        if (user && user.status === 'blocked') {
            return res.status(403).json({ success: false, message: "Your account is BLOCKED due to multiple policy violations." });
        }

        // 2. Call the Gemini AI Bouncer
        if (imageUrl) {
            const isApproved = await scanImageWithAI(imageUrl, issue); 
            
            if (!isApproved) {
                if (user) {
                    user.strikes += 1; 
                    if (user.strikes >= 3) {
                        user.status = 'blocked';
                        await user.save();
                        return res.status(403).json({ success: false, message: "❌ AI Rejected: Photo does not match the chosen category.\nYou have reached 3 strikes. Your account is now BLOCKED." });
                    }
                    await user.save();
                    return res.status(400).json({ success: false, message: `❌ AI Rejected: Photo does not match the category "${issue}". This is Strike ${user.strikes} of 3.` });
                }
                return res.status(400).json({ success: false, message: "❌ AI Rejected: Photo does not depict the chosen complaint." });
            }
        }

        // 🚀 NEW: 3. Call the Priority Analyzer
        let complaintPriority = "MEDIUM";
        if (description) {
            complaintPriority = await analyzePriority(issue, description);
        }

        // 4. If AI approves, save it normally with Priority
        const newComplaint = new Complaint({
            trackingId: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
            citizenName: username, barangay, category: issue, description, imageUrl,
            status: 'Pending',
            priority: complaintPriority, // 🚩 Priority saved here
            history: [{ status: 'Pending', note: 'Complaint officially filed by citizen.', updatedBy: username || 'System' }]
        });
        await newComplaint.save();
        res.json({ success: true, message: 'Complaint submitted!' });
    } catch (error) { 
        res.status(500).json({ success: false, error: error.message }); 
    }
});

app.get('/api/complaints', async (req, res) => {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    res.json({ complaints }); 
});

// --- LGU Status Route (Handles Manual Reject & Flag) ---
// --- LGU Status & Priority Override Route ---
app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        // 🚩 Added 'priority' to the destructured body
        const { status, note, adminName, priority } = req.body;
        
        const updateData = { 
            status: status, 
            lguNote: note 
        };

        // 🚀 NEW: If the admin provides a new priority, include it in the update
        if (priority) {
            updateData.priority = priority;
        }

        // Handle Manual Reject & Flag for the 3-Strike System [cite: 54, 55]
        if (status === 'Rejected & Flagged') {
            const complaint = await Complaint.findOne({ trackingId: req.params.id });
            if (complaint) {
                const user = await User.findOne({ username: complaint.citizenName });
                if (user) {
                    user.strikes += 1;
                    if (user.strikes >= 3) user.status = 'blocked'; [cite: 56]
                    await user.save();
                }
            }
        }

        const updatedComplaint = await Complaint.findOneAndUpdate(
            { trackingId: req.params.id }, 
            { 
                $set: updateData, // Updates status, note, and priority 
                $push: {
                    history: {
                        status: status,
                        note: note || (priority ? `Priority manually changed to ${priority}` : 'Status updated'), [cite: 58, 59]
                        updatedBy: adminName || 'LGU Admin' [cite: 60]
                    }
                }
            },
            { new: true }
        );

        res.json({ success: true, complaint: updatedComplaint }); [cite: 61]
    } catch (error) { 
        res.status(500).json({ error: "Failed to update complaint details." }); 
    }
});

// --- 5. SUPERADMIN IAM ---
app.get('/api/admin/users', async (req, res) => {
    const users = await User.find({ role: { $ne: 'superadmin' } });
    res.json({ users });
});

app.post('/api/admin/create-lgu', async (req, res) => {
    try {
        await new User({ username: req.body.username, email: req.body.email, password: req.body.password, role: 'lgu', authMethod: 'local' }).save();
        res.json({ success: true });
    } catch (error) { res.status(500).json({ success: false }); }
});

app.patch('/api/admin/users/:id/toggle-block', async (req, res) => {
    const user = await User.findById(req.params.id);
    if (user) { user.status = user.status === 'blocked' ? 'active' : 'blocked'; await user.save(); res.json({ success: true }); }
});

// ==========================================
// SUMBONG-BOT AI ROUTE
// ==========================================
app.post('/api/ai-chat', async (req, res) => {
    try {
        const { message, history } = req.body;
        const model = genAI.getGenerativeModel({ 
            model: "gemini-2.5-flash",
            // 🧠 UPGRADED PERSONALITY: Smarter, cleaner, and context-aware
            systemInstruction: `You are 'Sumbong-Bot', the official AI assistant of Kalapp (Sumbungan ng Bayan). Tone: Empathetic, 
            polite (uses 'po/opo'), conversational Taglish. 
            
            CRITICAL RULES:
            1. Keep it conversational. If the user just says "Hi" or "Hello", reply with a short, friendly greeting and ask how you can help. DO NOT send long paragraphs for a simple greeting.
            2. DO NOT use Markdown formatting. Never use asterisks (*) for bolding or italics. 
            Use plain, clean text only. Use standard line breaks if you need to list things.
            3. ONLY ask the 4 Ws (Ano, Sino, Saan, Kailan) step-by-step IF the user explicitly states they want to report an issue right now.
            4. Once you have their details or if they ask how to submit, direct them to use the 'File Complaint' form in the sidebar.`
        });
        
        const chat = model.startChat({ history: history || [] });
        const result = await chat.sendMessage(message);
        res.json({ reply: result.response.text() });
    } catch (error) { 
        console.error("❌ GEMINI AI ERROR:", error);
        res.status(500).json({ error: "AI Error" }); 
    }
});

// --- Start Server ---
app.listen(PORT, () => console.log(`🚀 Master Server running on port ${PORT}`));