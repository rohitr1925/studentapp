const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { BlobServiceClient } = require('@azure/storage-blob');
const sql = require('mssql');
const fs = require('fs');
const path = require('path');
const Joi = require('joi');
require('dotenv').config();

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

// Input validation schemas
const loginSchema = Joi.object({
  rollNumber: Joi.string().required(),
  dob: Joi.string().required(),
});

const assignmentSubmissionSchema = Joi.object({
  studentId: Joi.number().required(),
  assignmentId: Joi.number().required(),
  submissionDate: Joi.string().required(),
});

// Routes

// Serve the index.html as the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Handle Login Request
app.post('/login', async (req, res) => {
  const { error } = loginSchema.validate(req.body);
  if (error) return res.status(400).send({ message: error.details[0].message });

  const { rollNumber, dob } = req.body;
  try {
    await sql.connect(dbConfig);

    const request = new sql.Request();
    request.input('rollNumber', sql.VarChar, rollNumber);
    request.input('dob', sql.VarChar, dob);

    const result = await request.query(
      `SELECT id, fullName FROM students WHERE rollNumber = @rollNumber AND dob = @dob`
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

    const request = new sql.Request();
    request.input('studentId', sql.Int, studentId);

    const studentResult = await request.query(`SELECT * FROM students WHERE id = @studentId`);
    const assignmentsResult = await request.query(`SELECT * FROM assignments WHERE studentId = @studentId`);

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
  const { studentId, assignmentId, submissionDate } = req.body;

  const { error } = assignmentSubmissionSchema.validate({ studentId, assignmentId, submissionDate });
  if (error) return res.status(400).send({ message: error.details[0].message });

  try {
    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    // Optional: Validate file type and size
    if (!req.file.mimetype.startsWith('application/') || req.file.size > 5 * 1024 * 1024) {
      return res.status(400).send('Invalid file type or size exceeds 5MB.');
    }

    const fileUrl = await uploadFileToBlob(req.file);

    await sql.connect(dbConfig);

    const request = new sql.Request();
    request.input('studentId', sql.Int, studentId);
    request.input('assignmentId', sql.Int, assignmentId);
    request.input('submissionDate', sql.Date, submissionDate);
    request.input('fileUrl', sql.VarChar, fileUrl);

    await request.query(
      `INSERT INTO assignment_submission (studentId, assignmentId, submissionDate, fileUrl)
       VALUES (@studentId, @assignmentId, @submissionDate, @fileUrl)`
    );

    res.status(200).json({ message: 'Assignment submitted successfully.', fileUrl });
    fs.unlinkSync(req.file.path); // Clean up the file from local storage
  } catch (err) {
    console.error('Assignment submission error:', err);
    res.status(500).json({ message: 'Submission failed.' });
  }
});

// Ensure container exists
createContainerIfNotExists();

// Centralized error handling
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).send({ message: 'An unexpected error occurred!' });
});

// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
