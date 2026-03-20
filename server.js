require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const SibApiV3Sdk = require('sib-api-v3-sdk'); // Brevo Library
const multer = require('multer');
const path = require('path');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Brevo (Sib) Configuration ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = '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';
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

// Middleware
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- Schemas ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    role: { type: String, default: 'citizen' },
    isBlocked: { type: Boolean, default: false },
    otp: String,
    otpExpires: Date
});

const complaintSchema = new mongoose.Schema({
    citizenName: String,
    title: String,
    description: String,
    category: String,
    location: String,
    imageUrl: String,
    status: { type: String, default: 'Pending' },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- Multer Setup ---
const storage = multer.diskStorage({
    destination: './public/uploads/',
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage });

// --- ROUTES ---

// 1. Request OTP (Brevo Transactional API)
app.post('/api/request-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = new Date(Date.now() + 10 * 60000); 

    try {
        let user = await User.findOne({ email });
        if (user && user.isBlocked) return res.status(403).json({ message: 'Account is blocked.' });

        if (!user) {
            user = new User({ username: email.split('@')[0], email });
        }
        
        user.otp = otp;
        user.otpExpires = expires;
        await user.save();

        // Brevo Email Object
        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.subject = "Your Kalapp Verification Code";
        sendSmtpEmail.htmlContent = `
            <div style="font-family: sans-serif; padding: 20px; border: 1px solid #ddd; border-radius: 10px;">
                <h2 style="color: #ff8c00;">Kalapp Security</h2>
                <p>Hello! Your 6-digit verification code is:</p>
                <h1 style="letter-spacing: 5px; background: #f8f8f8; padding: 15px; display: inline-block; border-radius: 5px;">${otp}</h1>
                <p>This code will expire in 10 minutes. Please do not share it with anyone.</p>
            </div>`;
        sendSmtpEmail.sender = { "name": "Kalapp System", "email": "kalappscc@gmail.com" };
        sendSmtpEmail.to = [{ "email": email }];

        await tranEmailApi.sendTransacEmail(sendSmtpEmail);
        
        console.log(`✅ OTP sent to ${email}`);
        res.json({ message: 'OTP sent successfully!' });

    } catch (error) {
        console.error('Brevo Error:', error);
        res.status(500).json({ message: 'Email service error. Check logs.' });
    }
});

// 2. Verify OTP
app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const user = await User.findOne({ email, otp, otpExpires: { $gt: Date.now() } });

    if (user) {
        user.otp = undefined;
        user.otpExpires = undefined;
        await user.save();
        res.json({ message: 'Login successful!', username: user.username, role: user.role });
    } else {
        res.status(400).json({ message: 'Invalid or expired OTP.' });
    }
});

// 3. Super Admin Login
app.post('/api/super-login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'cityhall' && password === 'masterkey2026') {
        res.json({ message: 'Admin login successful!', role: 'superadmin' });
    } else {
        res.status(401).json({ message: 'Invalid admin credentials.' });
    }
});

// 4. Create Complaint
app.post('/api/complaints', upload.single('image'), async (req, res) => {
    try {
        const { citizenName, title, description, category, location } = req.body;
        const newComplaint = new Complaint({
            citizenName, title, description, category, location,
            imageUrl: req.file ? `/uploads/${req.file.filename}` : ''
        });
        await newComplaint.save();
        res.json({ message: 'Complaint submitted successfully!' });
    } catch (error) {
        res.status(500).json({ message: 'Submission failed.' });
    }
});

// 5. Get Complaints
app.get('/api/complaints', async (req, res) => {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    res.json(complaints);
});

app.listen(PORT, () => console.log(`🚀 Kalapp Server running on port ${PORT}`));