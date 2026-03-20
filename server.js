require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const SibApiV3Sdk = require('sib-api-v3-sdk'); // Brevo
const multer = require('multer');
const path = require('path');
const cors = require('cors');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3001;

// --- Setup Image Upload Folder ---
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// --- Middleware ---
app.use(express.json());
app.use(cors());
app.use(express.static('public'));
app.use('/uploads', express.static('public/uploads'));

// --- MongoDB Connection ---
mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('✅ Connected to MongoDB Atlas!'))
    .catch(err => console.error('❌ MongoDB Connection Error:', err));

// --- Schemas & Models ---
const userSchema = new mongoose.Schema({
    username: { type: String, required: true },
    email: { type: String }, // Optional for LGU/Admins created manually
    password: { type: String }, // Only used for LGU/Admins
    role: { type: String, default: 'citizen' }, // 'citizen', 'lgu', 'superadmin'
    status: { type: String, default: 'active' }, // 'active' or 'blocked'
    otp: String,
    otpExpires: Date
});

const complaintSchema = new mongoose.Schema({
    trackingId: String,
    citizenName: String,
    barangay: String,
    category: String,
    description: String,
    imageUrl: String,
    status: { type: String, default: 'Pending' },
    lguNote: String,
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);
const Complaint = mongoose.model('Complaint', complaintSchema);

// --- SEED SUPERADMIN (Runs once to ensure you have a master key) ---
async function seedAdmin() {
    const admin = await User.findOne({ username: 'cityhall' });
    if (!admin) {
        await User.create({ username: 'cityhall', password: 'masterkey2026', role: 'superadmin' });
        console.log("✅ SuperAdmin 'cityhall' created.");
    }
}
seedAdmin();

// --- Brevo Configuration ---
const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY; 
const tranEmailApi = new SibApiV3Sdk.TransactionalEmailsApi();

// --- Multer Setup (Basic Image Storage) ---
const upload = multer({ 
    storage: multer.diskStorage({
        destination: './public/uploads/',
        filename: (req, file, cb) => {
            cb(null, Date.now() + path.extname(file.originalname));
        }
    })
});

// ==========================================
// 🚀 ROUTES
// ==========================================

// --- 1. AUTHENTICATION (CITIZEN OTP) ---
// ==========================================
// 🚨 TEMPORARY: DATABASE WIPE ROUTE 🚨
// ==========================================
app.get('/api/nuke-database', async (req, res) => {
    try {
        // 1. Delete everything
        await User.deleteMany({});
        await Complaint.deleteMany({});
        
        // 2. Rebuild the Super Admin
        await User.create({ 
            username: 'cityhall', 
            password: 'masterkey2026', 
            role: 'superadmin',
            status: 'active'
        });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: red;">💥 DATABASE WIPED 💥</h1>
                <p>All old citizens, LGUs, and complaints have been permanently deleted.</p>
                <p><strong>Super Admin Restored:</strong> cityhall / masterkey2026</p>
                <a href="/superadmin-access.html" style="padding: 10px 20px; background: #ef4444; color: white; text-decoration: none; border-radius: 5px;">Go to Command Center</a>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error wiping database.');
    }
});

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

// --- 2. AUTHENTICATION (ADMIN / LGU PASSWORD) ---
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = await User.findOne({ username, password });
    
    if (user) {
        if (user.status === 'blocked') return res.status(403).json({ message: "Account Suspended." });
        res.json({ success: true, username: user.username, role: user.role });
    } else {
        res.status(401).json({ message: "Invalid credentials." });
    }
});

// --- 3. COMPLAINTS SYSTEM ---
app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description } = req.body;
        const newComplaint = new Complaint({
            trackingId: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
            citizenName: username,
            barangay: barangay,
            category: issue,
            description: description,
            imageUrl: req.file ? `/uploads/${req.file.filename}` : ''
        });
        await newComplaint.save();
        res.json({ success: true, message: 'Complaint submitted!' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Submission failed.' });
    }
});

app.get('/api/complaints', async (req, res) => {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    res.json({ complaints }); // Wrapped in an object to match your frontend logic
});

app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        await Complaint.findOneAndUpdate(
            { trackingId: req.params.id }, 
            { status: req.body.status, lguNote: req.body.note }
        );
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to update status" });
    }
});

// --- 4. SUPERADMIN IAM SYSTEM ---
app.get('/api/admin/users', async (req, res) => {
    const users = await User.find({ role: { $ne: 'superadmin' } });
    res.json({ users });
});

app.post('/api/admin/create-lgu', async (req, res) => {
    try {
        const { username, email, password } = req.body;
        const newUser = new User({ username, email, password, role: 'lgu' });
        await newUser.save();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

app.patch('/api/admin/users/:id/toggle-block', async (req, res) => {
    const user = await User.findById(req.params.id);
    if (user) {
        user.status = user.status === 'blocked' ? 'active' : 'blocked';
        await user.save();
        res.json({ success: true });
    }
});

app.patch('/api/admin/users/:id/reset-password', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { password: req.body.newPassword });
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`🚀 Master Server running on port ${PORT}`));