const mysql = require("mysql2/promise");

let mysqlConnection = null;

// ============================================
// DATABASE CONNECTION
// ============================================
const connectMySQL = async () => {
  try {
    const dbConfig = {
      host: "localhost",
      user: "root",
      password: "", 
      database: "sl-wp",       waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    };

    mysqlConnection = await mysql.createPool(dbConfig);

    // Test the connection
    const connection = await mysqlConnection.getConnection();
    await connection.ping();
    connection.release();

    console.log("✅ MySQL connected successfully");

    // Print wp_users table structure + sample values
    await printWpUsersTable();
  } catch (error) {
    console.error("❌ MySQL connection failed:", error);
    throw error;
  }
};

// ============================================
// PRINT wp_users TABLE STRUCTURE + VALUES
// ============================================
const printWpUsersTable = async () => {
  try {
    if (!mysqlConnection) {
      throw new Error("MySQL connection is not initialized");
    }

    const [columns] = await mysqlConnection.execute(
      `DESCRIBE wp_users`
    );

    console.log("\n📌 wp_users TABLE STRUCTURE:");
    columns.forEach((col) => {
      console.log(
        `- ${col.Field} | ${col.Type} | Null: ${col.Null} | Key: ${col.Key} | Default: ${col.Default}`
      );
    });

    const [rows] = await mysqlConnection.execute(
      `SELECT * FROM wp_users LIMIT 5`
    );

    console.log("\n📌 wp_users SAMPLE ROWS:");
    console.dir(rows, { depth: null });

  } catch (err) {
    console.error("❌ Failed to read wp_users table:", err.message);
  }
};

// ============================================
// INIT
// ============================================
(async () => {
  await connectMySQL();
})();

module.exports = {
  connectMySQL,
};
