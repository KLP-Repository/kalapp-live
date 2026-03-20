require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const SibApiV3Sdk = require('sib-api-v3-sdk');
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
    email: { type: String }, 
    password: { type: String }, 
    role: { type: String, default: 'citizen' }, 
    status: { type: String, default: 'active' }, 
    authMethod: { type: String, default: 'local' }, // Tracks OTP vs Google
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

const upload = multer({ 
    storage: multer.diskStorage({
        destination: './public/uploads/',
        filename: (req, file, cb) => { cb(null, Date.now() + path.extname(file.originalname)); }
    })
});

// ==========================================
// 🚨 DATABASE WIPE ROUTE 🚨
// ==========================================
app.get('/api/nuke-database', async (req, res) => {
    try {
        await User.deleteMany({});
        await Complaint.deleteMany({});
        await User.create({ username: 'cityhall', password: 'masterkey2026', role: 'superadmin', status: 'active', authMethod: 'local' });

        res.send(`
            <div style="font-family: sans-serif; text-align: center; margin-top: 50px;">
                <h1 style="color: red;">💥 DATABASE WIPED 💥</h1>
                <p>All old citizens, LGUs, and complaints have been permanently deleted.</p>
                <a href="/superadmin-access.html" style="padding: 10px 20px; background: #ef4444; color: white; text-decoration: none; border-radius: 5px;">Go to Command Center</a>
            </div>
        `);
    } catch (err) {
        res.status(500).send('Error wiping database.');
    }
});

// ==========================================
// 🚀 ROUTES
// ==========================================

// --- 1. CITIZEN OTP LOGIN ---
app.post('/api/request-otp', async (req, res) => {
    const { email, username, password } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    try {
        let user = await User.findOne({ email });
        
        // Strict Identity Protection Check
        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Account is suspended.' });
            if (user.authMethod === 'google') {
                return res.status(400).json({ message: 'This email is registered via Google. Please use the Google Sign-In button below.' });
            }
        }

        if (!user) user = new User({ username: username || email.split('@')[0], email, password, role: 'citizen', authMethod: 'local' });
        
        user.otp = otp;
        user.otpExpires = new Date(Date.now() + 10 * 60000);
        await user.save();

        const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
        sendSmtpEmail.sender = { "name": "Kalapp System", "email": "kalappscc@gmail.com" };
        sendSmtpEmail.to = [{ "email": email }];
        sendSmtpEmail.subject = "Your Kalapp Verification Code";
        sendSmtpEmail.htmlContent = `<h2>Your verification code is: <span style="background:#eee; padding:5px;">${otp}</span></h2>`;

        await tranEmailApi.sendTransacEmail(sendSmtpEmail);
        res.json({ message: 'OTP sent successfully!' });

    } catch (error) {
        res.status(500).json({ message: 'Failed to send OTP.' });
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

// --- 2. GOOGLE LOGIN ROUTE ---
app.post('/api/google-login', async (req, res) => {
    const { email, name } = req.body;
    try {
        let user = await User.findOne({ email });

        if (user) {
            if (user.status === 'blocked') return res.status(403).json({ message: 'Account is suspended.' });
            
            // Strict Identity Protection Check
            if (user.authMethod !== 'google') {
                return res.status(400).json({ message: 'This email is registered via OTP Email. Please use the standard login.' });
            }
            return res.json({ success: true, username: user.username, role: user.role });
        }

        // New Google User
        user = new User({ username: name, email: email, role: 'citizen', authMethod: 'google' });
        await user.save();
        res.json({ success: true, username: user.username, role: user.role });

    } catch (error) {
        res.status(500).json({ message: 'Google login failed on server.' });
    }
});

// --- 3. LGU/ADMIN LOGIN ---
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

// --- 4. COMPLAINTS SYSTEM ---
app.post('/api/complaints', upload.single('evidence'), async (req, res) => {
    try {
        const { username, barangay, issue, description } = req.body;
        const newComplaint = new Complaint({
            trackingId: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
            citizenName: username, barangay, category: issue, description,
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
    res.json({ complaints }); 
});

app.patch('/api/complaints/:id/status', async (req, res) => {
    try {
        await Complaint.findOneAndUpdate({ trackingId: req.params.id }, { status: req.body.status, lguNote: req.body.note });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to update status" });
    }
});

// --- 5. SUPERADMIN IAM SYSTEM ---
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
app.patch('/api/admin/users/:id/reset-password', async (req, res) => {
    await User.findByIdAndUpdate(req.params.id, { password: req.body.newPassword });
    res.json({ success: true });
});

app.listen(PORT, () => console.log(`🚀 Master Server running on port ${PORT}`));