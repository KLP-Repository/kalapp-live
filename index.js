require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const multer = require('multer'); 
const sharp = require('sharp'); // The image compression engine
const exifr = require('exifr'); // NEW: The EXIF Metadata Detective
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors()); 
app.use(express.json()); 
app.use(express.static('public'));

// --- Setup Image Upload Folder ---
const uploadDir = path.join(__dirname, 'public/uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true }); 
}

// --- Configure Multer with Memory Storage & Size Limit ---
const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
}).single('photo');

// --- DATABASE CONNECTION ---
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('✅ Successfully connected to MongoDB Atlas!'))
  .catch(err => console.error('❌ Error connecting to MongoDB:', err));

// --- DATABASE BLUEPRINTS (SCHEMAS) ---
const complaintSchema = new mongoose.Schema({
  id: String,
  barangay: String,
  issue: String,
  description: String,
  status: { type: String, default: 'Pending' },
  username: String,
  date: String,
  lguNote: String,
  imageUrl: String 
}, { timestamps: true });

const Complaint = mongoose.model('Complaint', complaintSchema);

const userSchema = new mongoose.Schema({
  username: String,
  password: String, 
  role: String
});

const User = mongoose.model('User', userSchema);

// --- SEED TEST ACCOUNTS ---
async function seedUsers() {
  const adminExists = await User.findOne({ username: 'admin' });
  if (!adminExists) await User.create({ username: 'admin', password: '123', role: 'lgu' });

  const citizenExists = await User.findOne({ username: 'juan' });
  if (!citizenExists) await User.create({ username: 'juan', password: '666', role: 'citizen' });
}
seedUsers();

// --- ROUTES ---

app.get('/api/complaints', async (req, res) => {
  try {
    const complaints = await Complaint.find().sort({ createdAt: -1 });
    res.json({ complaints });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch complaints" });
  }
});

app.get('/api/my-complaints', async (req, res) => {
  try {
    const username = req.query.username;
    const userComplaints = await Complaint.find({ username }).sort({ createdAt: -1 });
    res.json({ complaints: userComplaints });
  } catch (error) {
    res.status(500).json({ error: "Failed to fetch history" });
  }
});

// --- Advanced Complaint Submission with Security & Compression ---
app.post('/api/complaints', (req, res) => {
    // 1. Run the Multer upload function to check file size limits
    upload(req, res, async function (err) {
        if (err instanceof multer.MulterError) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, message: "File is too large! Maximum allowed is 5MB." });
            }
            return res.status(500).json({ success: false, message: "Upload error." });
        }

        // 2. Process the complaint
        try {
            const { barangay, category, description, username } = req.body;
            
            const timestamp = new Date().toLocaleString('en-PH', { 
                timeZone: 'Asia/Manila', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit'
            });

            let savedImageUrl = null;

            // 3. IF A PHOTO IS ATTACHED, RUN SECURITY PROTOCOLS!
            if (req.file) {
                // Dig into the file buffer to find original camera metadata. 
                // The .catch() prevents the server from crashing if the file is completely broken.
                const exifData = await exifr.parse(req.file.buffer).catch(() => null);

                // SECURITY TRAP: If it has no EXIF data or is missing the camera's original timestamp, REJECT IT!
                if (!exifData || !exifData.DateTimeOriginal) {
                    return res.status(400).json({ 
                        success: false, 
                        message: "Security Alert: This photo lacks original camera metadata. Screenshots or images downloaded from the internet are not allowed." 
                    });
                }

                // If it passes security, compress it using Sharp!
                const filename = Date.now() + '-' + Math.round(Math.random() * 1000) + '.webp';
                const filepath = path.join(uploadDir, filename);

                await sharp(req.file.buffer)
                    .resize({ width: 800, withoutEnlargement: true }) 
                    .webp({ quality: 80 }) 
                    .toFile(filepath);

                savedImageUrl = '/uploads/' + filename;
            }

            const newComplaint = new Complaint({
                id: 'KAL-' + Math.floor(1000 + Math.random() * 9000),
                barangay: barangay,
                issue: category, 
                description: description,
                username: username,
                date: timestamp,
                imageUrl: savedImageUrl // Save the compressed link
            });

            await newComplaint.save(); 
            res.json({ success: true, trackingId: newComplaint.id });

        } catch (error) {
            console.error(error);
            res.status(500).json({ error: "Failed to save complaint" });
        }
    });
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username: username, password: password });
    if (user) {
      res.json({ success: true, role: user.role });
    } else {
      res.status(401).json({ success: false, message: "Invalid username or password" });
    }
  } catch (error) {
    res.status(500).json({ error: "Server error during login" });
  }
});

app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const existingUser = await User.findOne({ username: username });
    if (existingUser) {
      return res.status(400).json({ success: false, message: "Username already taken." });
    }
    const newUser = new User({ username: username, password: password, role: 'citizen' });
    await newUser.save();
    res.json({ success: true, message: "Registration successful!" });
  } catch (error) {
    res.status(500).json({ error: "Server error during registration" });
  }
});

app.patch('/api/complaints/:id/status', async (req, res) => {
  try {
    const trackingId = req.params.id;
    const newStatus = req.body.status; 
    const newNote = req.body.note;
    
    await Complaint.findOneAndUpdate({ id: trackingId }, { status: newStatus, lguNote: newNote });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: "Failed to update status" });
  }
});

app.listen(PORT, () => console.log(`🚀 Kalapp Server running on port ${PORT}`));