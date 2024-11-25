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

// Enable CORS for all routes
app.use(cors());

// Middleware setup
app.use(express.static('public')); // Serve files from the 'public' directory
app.use(express.json()); // To parse JSON bodies

const port = 3000;

// Serve the index.html as the main page
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// SQL Configurations
const hubSQLConfig = {
  user: process.env.SQL_HUB_USER,
  password: process.env.SQL_HUB_PASSWORD,
  server: process.env.SQL_HUB_SERVER,
  database: process.env.SQL_HUB_DATABASE,
  options: { encrypt: true, trustServerCertificate: false },
};

const metadataSQLConfig = {
  user: process.env.SQL_METADATA_USER,
  password: process.env.SQL_METADATA_PASSWORD,
  server: process.env.SQL_METADATA_SERVER,
  database: process.env.SQL_METADATA_DATABASE,
  options: { encrypt: true, trustServerCertificate: false },
};

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

// SQL Functions
async function saveMetadataToHubDB(fileName, fileUrl, studentName, rollNumber, section, subject) {
  try {
    await sql.connect(hubSQLConfig);
    await sql.query(`
      INSERT INTO FileMetadata (fileName, fileUrl, studentName, rollNumber, section, subject)
      VALUES ('${fileName}', '${fileUrl}', '${studentName}', '${rollNumber}', '${section}', '${subject}')
    `);
    console.log('Metadata saved to Hub DB.');
  } catch (err) {
    console.error('Error saving metadata to Hub DB:', err);
  }
}

async function logSyncOperation(fileName, status) {
  try {
    await sql.connect(metadataSQLConfig);
    await sql.query(`
      INSERT INTO SyncLog (operation, sourceDatabase, targetDatabase, syncStatus, fileName)
      VALUES ('Upload', 'SyncHubDB', 'SyncMetadataDB', '${status}', '${fileName}')
    `);
    console.log('Sync operation logged in Metadata DB.');
  } catch (err) {
    console.error('Error logging sync operation:', err);
  }
}

// File Upload Route
app.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const { studentName, rollNumber, section, subject } = req.body;

    if (!req.file) {
      return res.status(400).send('No file uploaded.');
    }

    const fileUrl = await uploadFileToBlob(req.file);

    await saveMetadataToHubDB(req.file.filename, fileUrl, studentName, rollNumber, section, subject);
    await logSyncOperation(req.file.filename, 'Success');

    res.status(200).json({ message: 'File uploaded successfully.', fileUrl });
    fs.unlinkSync(req.file.path);
  } catch (err) {
    console.error('Upload error:', err);
    await logSyncOperation(req.file?.filename || 'unknown', 'Failed');
    res.status(500).send('Upload failed.');
  }
});

// Handle Login Request
app.post('/login', async (req, res) => {
  const { rollNumber, dob } = req.body;
  try {
    await sql.connect(hubSQLConfig);
    const result = await sql.query(`
      SELECT * FROM Students WHERE rollNumber = '${rollNumber}' AND dob = '${dob}'
    `);

    if (result.recordset.length > 0) {
      res.status(200).json({ message: 'Login successful' });
    } else {
      res.status(400).json({ message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Handle Registration Request
app.post('/register', async (req, res) => {
  const { rollNumber, fullName, email, dob, section } = req.body;
  try {
    await sql.connect(hubSQLConfig);
    const result = await sql.query(`
      INSERT INTO Students (rollNumber, fullName, email, dob, section)
      VALUES ('${rollNumber}', '${fullName}', '${email}', '${dob}', '${section}')
    `);

    res.status(201).json({ message: 'Registration successful' });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Ensure container exists
createContainerIfNotExists();

// Start server
app.listen(port, () => {
  console.log(`Server is running at http://localhost:${port}`);
});
