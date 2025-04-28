const { initializeDatabase, updateDatabaseSchema } = require('./db');

async function init() {
    try {
        console.log('Starting database initialization...');
        
        // Initialize base tables
        await initializeDatabase();
        console.log('Base tables initialized successfully');
        
        // Update schema with any new columns
        await updateDatabaseSchema();
        console.log('Schema updates applied successfully');
        
        console.log('Database initialization completed successfully');
        process.exit(0);
    } catch (error) {
        console.error('Error during database initialization:', error);
        process.exit(1);
    }
}

init(); 