const mysql = require('mysql2/promise');
require('dotenv').config();

// Parse database credentials from Upsun environment
const credentials = process.env.PLATFORM_RELATIONSHIPS ? 
  JSON.parse(process.env.PLATFORM_RELATIONSHIPS).database[0].host : null;

// Create connection pool
const pool = mysql.createPool({
  host: credentials ? credentials.host : process.env.DB_HOST || 'localhost',
  port: credentials ? credentials.port : process.env.DB_PORT || 3306,
  user: credentials ? credentials.username : process.env.DB_USER || 'wahaj',
  password: credentials ? credentials.password : process.env.DB_PASSWORD || '1234',
  database: credentials ? credentials.path : process.env.DB_NAME || 'frontify_logs',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

// Initialize database tables
async function initializeDatabase() {
  try {
    const connection = await pool.getConnection();
    
    // Create API logs table
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS api_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id VARCHAR(255),
        endpoint VARCHAR(255),
        method VARCHAR(10),
        status_code INT,
        request_body TEXT,
        response_body TEXT,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    
    connection.release();
    console.log('Database tables initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// First, add the new columns to the database
async function updateDatabaseSchema() {
  try {
    const connection = await pool.getConnection();
    
    // Check if columns exist first
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_NAME = 'api_logs' 
      AND COLUMN_NAME IN ('user_email', 'user_name')
    `);
    
    const existingColumns = columns.map(col => col.COLUMN_NAME);
    
    // Add columns if they don't exist
    if (!existingColumns.includes('user_email')) {
      await connection.execute(`
        ALTER TABLE api_logs 
        ADD COLUMN user_email VARCHAR(255) AFTER user_id
      `);
    }
    
    if (!existingColumns.includes('user_name')) {
      await connection.execute(`
        ALTER TABLE api_logs 
        ADD COLUMN user_name VARCHAR(255) AFTER user_email
      `);
    }
    
    connection.release();
    console.log('Database schema updated successfully');
  } catch (error) {
    console.error('Error updating database schema:', error);
  }
}

// Update the logging function to handle missing user info
async function logApiCall(userInfo, endpoint, method, status_code, request_body, response_body, error_message) {
  console.log('logApiCall received user info:', userInfo);
  
  try {
    // First try to log with all columns
    const query = `
      INSERT INTO api_logs 
      (user_id, user_email, user_name, endpoint, method, status_code, request_body, response_body, error_message)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const values = [
      userInfo.id,
      userInfo.email,
      userInfo.name,
      endpoint,
      method,
      status_code,
      JSON.stringify(request_body),
      JSON.stringify(response_body),
      error_message
    ];

    console.log('Executing SQL query with values:', {
      user_id: userInfo.id,
      user_email: userInfo.email,
      user_name: userInfo.name,
      endpoint,
      method,
      status_code
    });

    await pool.query(query, values);
    console.log('Successfully logged API call with user info');
  } catch (error) {
    console.error('Error in logApiCall:', error);
    throw error;
  }
}

// Get logs for a specific user
async function getUserLogs(userId, limit = 100) {
  try {
    const connection = await pool.getConnection();
    
    const [rows] = await connection.execute(
      'SELECT * FROM api_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?',
      [userId, limit]
    );
    
    connection.release();
    return rows;
  } catch (error) {
    console.error('Error getting user logs:', error);
    return [];
  }
}

module.exports = {
  pool,
  initializeDatabase,
  updateDatabaseSchema,
  logApiCall,
  getUserLogs
}; 