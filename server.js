require('dotenv').config(); // MUST BE LINE 1: Unlocks your secure .env vault
const express = require('express');
const nodemailer = require('nodemailer');
const path = require('path');
const multer = require('multer'); 
const fs = require('fs');
const mongoose = require('mongoose');

const app = express();
// Use cloud port if available, otherwise strictly use 3001 to avoid zombie ports
const PORT = process.env.PORT || 3001; 

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- 1. MONGODB SETUP (Secured via .env) ---
const mongoURI = process.env.MONGODB_URI;

mongoose.connect(mongoURI)
    .then(() => console.log('✅ Connected to MongoDB Atlas permanently!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- 2. DATABASE BLUEPRINTS (Schemas) ---
const userSchema = new mongoose.Schema({
    email: String,
    username: String,
    password: String,
    role: { type: String, default: 'citizen' },
    status: { type: String, default: 'active' } 
});
const User = mongoose.model('User', userSchema);

const complaintSchema = new mongoose.Schema({
    id: String,
    date: String,
    username: String,
    barangay: String,
    issue: String,
    description: String,
    status: { type: String, default: 'Pending' },
    lguNote: { type: String, default: '' },
    imageUrl: String
});
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- 3. FILE UPLOAD SETUP (Multer) ---
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true }); 

const storage = multer.diskStorage({
    destination: function (req, file, cb) { cb(null, uploadDir) },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname.replace(/\s+/g, '-'))
    }
});
const upload = multer({ storage: storage });

// --- 4. EMAIL SETUP (Secured via .env) ---
const otpStore = {}; 
const transporter = nodemailer.createTransport({
    service: 'gmail', // Adding this helps Render identify the route
    host: 'smtp.gmail.com',
    port: 465,
    secure: true, 
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
    },
    tls: {
        // This is the "magic" line that helps bypass server restrictions
        rejectUnauthorized: false 
    }
});

// --- 5. PUBLIC AUTHENTICATION ROUTES ---
app.post('/api/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const validUser = await User.findOne({ username: username, password: password });
        
        if (validUser) {
            // Check if City Hall brought down the Ban Hammer
            if (validUser.status === 'blocked') {
                return res.json({ success: false, message: 'Account has been suspended by City Hall.' });
            }
            return res.json({ success: true, role: validUser.role });
        } else {
            return res.json({ success: false, message: 'Invalid credentials.' });
        }
    } catch (err) {
        res.status(500).json({ success: false, message: 'Server error' });
    }
});

app.post('/api/request-otp', async (req, res) => {
    const { email, username, password } = req.body;
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    otpStore[email] = { otp: otpCode, username, password, expires: Date.now() + 300000 };
    
    try {
        await transporter.sendMail({
            from: '"Kalapp System" <kalappscc@gmail.com>', 
            to: email,
            subject: 'Your Kalapp Verification Code',
            text: `Hello ${username},\n\nYour verification code is: ${otpCode}\n\nIt will expire in 5 minutes.`
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    const record = otpStore[email];
    
    if (record && record.otp === otp && Date.now() < record.expires) {
        const newUser = new User({
            email: email,
            username: record.username,
            password: record.password,
            role: 'citizen'
        });
        await newUser.save();
        
        delete otpStore[email]; 
        res.json({ success: true, username: record.username });
    } else {
        res.json({ success: false });
    }
});

// --- 6. BARANGAY LGU DASHBOARD ROUTES ---
app.get('/api/complaints', async (req, res) => {
    try {
        const allComplaints = await Complaint.find().sort({ _id: -1 });
        res.json({ complaints: allComplaints });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description } = req.body;
        const todayString = new Date().toLocaleDateString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric' });
        const randomId = Math.floor(1000 + Math.random() * 9000);
        const imageUrl = req.file ? `/uploads/${req.file.filename}` : '';

        const newComplaint = new Complaint({
            id: `KAL-${randomId}`,
            date: todayString,
            username: username,
            barangay: barangay,
            issue: issue,
            description: description,
            imageUrl: imageUrl
        });
        await newComplaint.save();
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        const { id } = req.params;
        const { status, note } = req.body;
        await Complaint.findOneAndUpdate(
            { id: id }, 
            { status: status, lguNote: note !== undefined ? note : "" }
        );
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ success: false });
    }
});

// --- 7. CITY HALL SUPER ADMIN ROUTES ---
app.post('/api/super-login', (req, res) => {
    const { username, password } = req.body;
    if (username === 'cityhall' && password === 'masterkey2026') {
        return res.json({ success: true });
    } else {
        return res.json({ success: false });
    }
});

app.get('/api/admin/users', async (req, res) => {
    try {
        const users = await User.find({ role: { $ne: 'superadmin' } }); 
        res.json({ success: true, users });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.post('/api/admin/create-lgu', async (req, res) => {
    try {
        const { username, password, email } = req.body;
        const newLgu = new User({ email, username, password, role: 'lgu', status: 'active' });
        await newLgu.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.patch('/api/admin/users/:id/toggle-block', async (req, res) => {
    try {
        const user = await User.findById(req.params.id);
        user.status = user.status === 'active' ? 'blocked' : 'active';
        await user.save();
        res.json({ success: true, newStatus: user.status });
    } catch (err) { res.status(500).json({ success: false }); }
});

app.patch('/api/admin/users/:id/reset-password', async (req, res) => {
    try {
        const { newPassword } = req.body;
        await User.findByIdAndUpdate(req.params.id, { password: newPassword });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ success: false }); }
});

// --- 8. SERVER IGNITION ---
app.listen(PORT, () => {
    console.log(`🚀 Kalapp Server running on port ${PORT}`);
}).on('error', (err) => {
    console.error(`❌ FATAL PORT ERROR: ${err.message}`);
});