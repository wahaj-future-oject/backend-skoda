const mysql = require('mysql2/promise');
require('dotenv').config();

// Function to get database config from Upsun environment
function getDatabaseConfig() {
  if (process.env.PLATFORM_RELATIONSHIPS) {
    try {
      const relationships = JSON.parse(Buffer.from(process.env.PLATFORM_RELATIONSHIPS, 'base64').toString());
      const dbRelation = relationships.database[0];
      return {
        host: dbRelation.host,
        port: dbRelation.port,
        user: dbRelation.username,
        password: dbRelation.password,
        database: dbRelation.path,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
      };
    } catch (error) {
      console.error('Error parsing database configuration:', error);
    }
  }

  // Fallback to local configuration
  return {
    host: process.env.DB_HOST || 'localhost',
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'main',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
  };
}

// Create the connection pool using the configuration
const pool = mysql.createPool(getDatabaseConfig());

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