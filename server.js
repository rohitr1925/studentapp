const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const sql = require('mssql');
const fs = require('fs');
require('dotenv').config();
const path = require('path');

// Initialize express app
const app = express();
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

const port = 3000;

// SQL Configurations
const dbConfig = {
  user: process.env.SQL_HUB_USER,
  password: process.env.SQL_HUB_PASSWORD,
  server: process.env.SQL_HUB_SERVER,
  database: process.env.SQL_HUB_DATABASE,
  options: { encrypt: true, trustServerCertificate: false },
};

// Middleware for file uploads
const upload = multer({ dest: 'uploads/' });

// Azure Blob Functions
async function createContainerIfNotExists() {
  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);

  const exists = await containerClient.exists();
  if (!exists) {
    await containerClient.create();
    console.log('Azure Blob container created.');
  }
}

async function uploadFileToBlob(file) {
  const blobServiceClient = BlobServiceClient.fromConnectionString(process.env.AZURE_STORAGE_CONNECTION_STRING);
  const containerClient = blobServiceClient.getContainerClient(process.env.AZURE_CONTAINER_NAME);
  const blockBlobClient = containerClient.getBlockBlobClient(file.filename);

  await blockBlobClient.uploadFile(file.path);
  return blockBlobClient.url;
}

// Routes

// Serve the index.html as the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle Login Request
app.post('/login', async (req, res) => {
  const { rollNumber, dob } = req.body;
  try {
    await sql.connect(dbConfig);
    const result = await sql.query(
      `SELECT id, fullName FROM students WHERE rollNumber = @rollNumber AND dob = @dob`,
      { rollNumber, dob }
    );

    if (result.recordset.length > 0) {
      res.status(200).json({ studentId: result.recordset[0].id, name: result.recordset[0].fullName });
    } else {
      res.status(400).json({ message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Dashboard Route
app.get('/api/dashboard/:studentId', async (req, res) => {
  const { studentId } = req.params;
  try {
    await sql.connect(dbConfig);

    // Query student and assignments data
    const studentQuery = `SELECT * FROM students WHERE id = @studentId`;
    const assignmentsQuery = `SELECT * FROM assignments WHERE studentId = @studentId`;

    const [studentResult, assignmentsResult] = await Promise.all([
      sql.query(studentQuery, { studentId }),
      sql.query(assignmentsQuery, { studentId }),
    ]);

    res.status(200).json({
      student: studentResult.recordset[0],
      assignments: assignmentsResult.recordset,
    });
  } catch (err) {
    console.error('Error fetching dashboard data:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Assignment Submission Route
app.post('/submit-assignment', upload.single('file'), async (req, res) => {
  try {
    const { studentId, assignmentId, submissionDate } = req.body;

    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const fileUrl = await uploadFileToBlob(req.file);

    await sql.connect(dbConfig);
    await sql.query(
      `INSERT INTO assignment_submission (studentId, assignmentId, submissionDate, fileUrl)
       VALUES (@studentId, @assignmentId, @submissionDate, @fileUrl)`,
      { studentId, assignmentId, submissionDate, fileUrl }
    );

    res.status(200).json({ message: 'Assignment submitted successfully.', fileUrl });
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error('Assignment submission error:', err);
    res.status(500).json({ message: 'Submission failed.' });
  }
});

// Ensure container exists
createContainerIfNotExists();

// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
  
