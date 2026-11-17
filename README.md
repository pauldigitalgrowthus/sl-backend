# Express.js Backend with MySQL Authentication & Subscription System

A complete Express.js backend application with MySQL database for user authentication, profile management, and subscription-based role assignment.

## 🚀 Features

- **User Authentication**: JWT-based authentication with MySQL database
- **Subscription-Based Role Assignment**: Users get roles based on their subscription plans
- **Dynamic Role Management**: Create, update, and delete roles with automatic ENUM synchronization
- **User Registration**: Secure user registration with subscription selection
- **User Login**: Secure login with automatic role verification
- **Profile Management**: Get and update user profiles
- **Subscription Management**: Purchase, view, and manage subscriptions
- **Role-Based Access Control**: Middleware for protecting routes based on roles and features
- **Automatic ENUM Sync**: User type ENUM automatically syncs with role changes
- **Orphaned User Handling**: Automatic detection and reassignment of users with invalid roles
- **Bulk User Reassignment**: API endpoints for reassigning users between roles
- **Security**: Helmet, CORS, rate limiting, and input validation
- **API Documentation**: Comprehensive REST API endpoints
- **Error Handling**: Centralized error handling and response formatting

## 📋 Prerequisites

- Node.js (v14 or higher)
- MySQL (v8.0 or higher)
- npm or yarn

## 🛠️ Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd sl_backend
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up environment variables:**
   ```bash
   cp env.example .env
   ```
   
   Edit `.env` file with your MySQL credentials:
   ```env
   # Server Configuration
   PORT=3000
   NODE_ENV=development

   # MySQL Configuration
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=root
   MYSQL_PASSWORD=your_mysql_password
   MYSQL_DATABASE=sl_backend

   # JWT Configuration
   JWT_SECRET=your_jwt_secret_key_here_make_it_long_and_random
   JWT_EXPIRES_IN=24h

   # Rate Limiting
   RATE_LIMIT_WINDOW_MS=900000
   RATE_LIMIT_MAX_REQUESTS=100
   ```

4. **Set up MySQL database:**
   ```sql
   CREATE DATABASE sl_backend;
   ```

5. **Start the server:**
   ```bash
   npm run dev
   ```

## 📚 API Documentation

### Authentication Endpoints

#### Register User with Subscription
```http
POST /api/auth/register
Content-Type: application/json

{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "password": "Password123",
  "phone": "+1234567890",
  "subscriptionId": 1
}
```

**Response:**
```json
{
  "success": true,
  "message": "User registered successfully",
  "data": {
    "user": {
      "id": 1,
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "role": "composer",
      "bio": null,
      "avatar": null,
      "website_url": null,
      "twitter_url": null,
      "country": null,
      "state_province": null,
      "city": null,
      "postal_code": null,
      "language": null,
      "badges": null,
      "permissions": null,
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Login User
```http
POST /api/auth/login
Content-Type: application/json

{
  "email": "john@example.com",
  "password": "Password123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Login successful",
  "data": {
    "user": {
      "id": 1,
      "first_name": "John",
      "last_name": "Doe",
      "email": "john@example.com",
      "phone": "+1234567890",
      "role": "composer",
      "bio": null,
      "avatar": null,
      "website_url": null,
      "twitter_url": null,
      "country": null,
      "state_province": null,
      "city": null,
      "postal_code": null,
      "language": null,
      "badges": null,
      "permissions": null,
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    },
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Get Current User Profile
```http
GET /api/auth/profile
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "message": "Profile retrieved successfully",
  "data": {
    "user": {
      "id": 1,
      "username": "john_doe",
      "email": "john@example.com",
      "first_name": "John",
      "last_name": "Doe",
      "bio": "Software Developer",
      "avatar": null,
      "phone": "+1234567890",
      "date_of_birth": "1990-01-01",
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

#### Update Profile
```http
PUT /api/auth/profile
Authorization: Bearer <token>
Content-Type: application/json

{
  "firstName": "John",
  "lastName": "Smith",
  "bio": "Software Developer",
  "phone": "+9876543210",
  "websiteUrl": "https://example.com",
  "twitterUrl": "https://twitter.com/johnsmith",
  "country": "United States",
  "stateProvince": "California",
  "city": "San Francisco",
  "postalCode": "94102",
  "language": "English",
  "badges": ["parish", "diocese", "ministries"],
  "permissions": { "showProfile": true }
}
```

**Response:**
```json
{
  "success": true,
  "message": "Profile updated successfully",
  "data": {
    "user": {
      "id": 1,
      "first_name": "John",
      "last_name": "Smith",
      "email": "john@example.com",
      "phone": "+9876543210",
      "role": "composer",
      "bio": "Software Developer",
      "avatar": null,
      "website_url": "https://example.com",
      "twitter_url": "https://twitter.com/johnsmith",
      "country": "United States",
      "state_province": "California",
      "city": "San Francisco",
      "postal_code": "94102",
      "language": "English",
      "badges": ["parish", "diocese", "ministries"],
      "permissions": { "showProfile": true },
      "created_at": "2024-01-01T00:00:00.000Z",
      "updated_at": "2024-01-01T00:00:00.000Z"
    }
  },
  "timestamp": "2024-01-01T00:00:00.000Z"
}
```

### Health Check
```http
GET /health
```

**Response:**
```json
{
  "status": "OK",
  "message": "Server is running",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "environment": "development"
}
```

## 💳 Subscription System

### Get Available Subscriptions
```http
GET /api/subscriptions
```

**Response:**
```json
{
  "success": true,
  "data": {
    "subscriptions": [
      {
        "id": 1,
        "name": "Basic Composer",
        "description": "Basic access for composers with limited features",
        "price": 9.99,
        "duration_days": 30,
        "role": "composer",
        "features": ["basic_composition", "limited_downloads", "community_access"]
      }
    ]
  }
}
```

### Purchase Subscription
```http
POST /api/subscriptions/purchase
Authorization: Bearer <token>
Content-Type: application/json

{
  "subscriptionId": 2,
  "paymentMethod": "credit_card",
  "amountPaid": 19.99
}
```

### Get My Subscription
```http
GET /api/subscriptions/my-subscription
Authorization: Bearer <token>
```

### Get Subscription History
```http
GET /api/subscriptions/my-subscription-history
Authorization: Bearer <token>
```

### Cancel Subscription
```http
PUT /api/subscriptions/cancel
Authorization: Bearer <token>
```

## 🔐 Role-Based Access Control

The system includes middleware for protecting routes based on user roles and subscription features:

```javascript
const { requireRole, requireFeature, requireActiveSubscription } = require('./middleware/roleAuth');

// Require minimum role level
app.get('/admin', requireRole('sl_team'), adminController);

// Require specific feature access
app.get('/advanced-tools', requireFeature('advanced_tools'), toolsController);

// Require active subscription
app.get('/premium-content', requireActiveSubscription(), premiumController);
```

## 🗄️ Database Schema

### Users Table
```sql
CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  first_name VARCHAR(50) NOT NULL,
  last_name VARCHAR(50) NOT NULL,
  email VARCHAR(100) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  phone VARCHAR(20),
  role ENUM('sl_team', 'composer', 'music', 'educator', 'planner', 'documents') DEFAULT 'composer',
  bio TEXT,
  avatar VARCHAR(255),
  website_url VARCHAR(255),
  twitter_url VARCHAR(255),
  country VARCHAR(100),
  state_province VARCHAR(100),
  city VARCHAR(100),
  postal_code VARCHAR(20),
  language VARCHAR(50),
  badges JSON,
  permissions JSON,
  is_active BOOLEAN DEFAULT TRUE,
  last_login TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### Subscriptions Table
```sql
CREATE TABLE subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  description TEXT,
  price DECIMAL(10,2) NOT NULL,
  duration_days INT NOT NULL,
  role ENUM('sl_team', 'composer', 'music', 'educator', 'planner', 'documents') NOT NULL,
  features JSON,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

### User Subscriptions Table
```sql
CREATE TABLE user_subscriptions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  subscription_id INT NOT NULL,
  start_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  end_date TIMESTAMP NULL,
  status ENUM('active', 'expired', 'cancelled') DEFAULT 'active',
  payment_status ENUM('pending', 'completed', 'failed', 'refunded') DEFAULT 'pending',
  payment_method VARCHAR(100),
  amount_paid DECIMAL(10,2),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_user_id (user_id),
  INDEX idx_subscription_id (subscription_id),
  INDEX idx_status (status),
  INDEX idx_end_date (end_date)
);
```

### User Roles
- **sl_team**: Simply Liturgical team members with full access
- **composer**: Can create and manage liturgical music compositions
- **music**: Music-related content creators and managers
- **educator**: Can create educational content and manage courses
- **planner**: Event and service planners
- **documents**: Document managers and content creators

## 🔒 Security Features

- **Password Hashing**: bcryptjs for secure password storage
- **JWT Authentication**: Secure token-based authentication
- **Input Validation**: express-validator for request validation
- **Rate Limiting**: Protection against brute force attacks
- **CORS**: Cross-origin resource sharing configuration
- **Helmet**: Security headers for Express.js
- **SQL Injection Protection**: Parameterized queries with mysql2

## 🧪 Testing

### Authentication Testing
To test the authentication functionality:

1. **Install axios for testing:**
   ```bash
   npm install axios
   ```

2. **Start the server:**
   ```bash
   npm run dev
   ```

3. **Run the authentication test script:**
   ```bash
   node test-auth.js
   ```

The authentication test script will:
- Register a new user
- Login with the registered user
- Get user profile
- Update user profile
- Test health check

### Subscription System Testing
To test the subscription system:

1. **Run the subscription test script:**
   ```bash
   node test-subscription.js
   ```

The subscription test script will:
- Get available subscriptions
- Register users with different subscriptions
- Test login with role verification
- Test subscription management
- Test role-based access control
- Test subscription purchase flow

### Manual Testing with cURL

#### Register with Subscription
```bash
curl -X POST http://localhost:5000/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "password": "TestPass123",
    "phone": "+1234567890",
    "subscriptionId": 1
  }'
```

#### Get Subscriptions
```bash
curl -X GET http://localhost:5000/api/subscriptions
```

#### Purchase Subscription
```bash
curl -X POST http://localhost:5000/api/subscriptions/purchase \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "subscriptionId": 2,
    "paymentMethod": "credit_card",
    "amountPaid": 19.99
  }'
```

## 📁 Project Structure

```
sl_backend/
├── config/
│   └── mysql.js            # MySQL connection configuration
├── middleware/
│   ├── auth.js             # Authentication middleware
│   ├── validation.js       # Request validation middleware
│   └── roleAuth.js         # Role-based access control middleware
├── routes/
│   ├── auth.js             # Authentication routes
│   └── subscriptions.js    # Subscription management routes
├── utils/
│   ├── response.js         # Response utility functions
│   └── subscription.js     # Subscription utility functions
├── server.js               # Main server file
├── package.json            # Dependencies and scripts
├── env.example             # Environment variables example
├── test-auth.js            # Authentication test script
├── test-subscription.js    # Subscription system test script
├── SUBSCRIPTION_SYSTEM.md  # Detailed subscription system documentation
├── .gitignore              # Git ignore file
└── README.md               # Project documentation
```

## 🚀 Deployment

### Local Development
```bash
npm run dev
```

### Production
```bash
npm start
```

## 📝 Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 3000 |
| `NODE_ENV` | Environment | development |
| `MYSQL_HOST` | MySQL host | localhost |
| `MYSQL_PORT` | MySQL port | 3306 |
| `MYSQL_USER` | MySQL username | root |
| `MYSQL_PASSWORD` | MySQL password | - |
| `MYSQL_DATABASE` | MySQL database name | sl_backend |
| `JWT_SECRET` | JWT secret key | - |
| `JWT_EXPIRES_IN` | JWT expiration time | 24h |
| `RATE_LIMIT_WINDOW_MS` | Rate limit window | 900000 |
| `RATE_LIMIT_MAX_REQUESTS` | Max requests per window | 100 |

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📄 License

This project is licensed under the ISC License.

## 🆘 Support

If you encounter any issues or have questions, please:

1. Check the documentation
2. Search existing issues
3. Create a new issue with detailed information

1. Check the documentation
2. Search existing issues
3. Create a new issue with detailed information

## 🎭 Role Management System

### Overview
The application includes a comprehensive role management system with automatic ENUM synchronization that ensures database consistency.

### Key Features
- **Dynamic Role CRUD**: Create, read, update, and delete roles via API
- **Automatic ENUM Sync**: User type ENUM automatically syncs with role changes
- **Orphaned User Handling**: Automatic detection and reassignment of invalid user types
- **Bulk User Reassignment**: API endpoints for moving users between roles
- **Comprehensive Logging**: Detailed console logs for all role operations

### API Endpoints

#### Role Management
```bash
# Get all roles
GET /api/roles-permissions/roles

# Create new role
POST /api/roles-permissions/roles
{
  "role_name": "Content Creator",
  "description": "Role for content creators",
  "permissions": {
    "can_create_content": true,
    "can_edit_own_content": true
  }
}

# Update role
PUT /api/roles-permissions/roles/:slug
{
  "role_name": "Senior Content Creator",
  "permissions": {
    "can_create_content": true,
    "can_edit_any_content": true
  }
}

# Delete role
DELETE /api/roles-permissions/roles/:slug
```

#### User Reassignment
```bash
# Reassign all users from one role to another
POST /api/roles-permissions/reassign-users
{
  "from_role_slug": "old_role",
  "to_role_slug": "new_role"
}

# Reassign specific users
POST /api/roles-permissions/reassign-users
{
  "user_ids": [1, 2, 3],
  "to_role_slug": "new_role"
}

# Manual ENUM synchronization
POST /api/roles-permissions/sync-enum
```

### Administrative Scripts

#### Find Orphaned Users
```bash
node scripts/find_orphaned_users.js
```
This script identifies users with invalid `user_type` values that don't exist in the role_permissions table.

#### Sync User Type ENUM
```bash
node scripts/sync-user-type-enum.js
```
Manually synchronize the user_type ENUM with available roles.

### Database Schema

#### role_permissions Table
```sql
CREATE TABLE role_permissions (
  id INT AUTO_INCREMENT PRIMARY KEY,
  role_name VARCHAR(100) NOT NULL,
  slug VARCHAR(100) UNIQUE NOT NULL,
  description TEXT,
  permissions JSON,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);
```

#### users Table (user_type field)
```sql
ALTER TABLE users 
ADD COLUMN user_type ENUM('sl_team') DEFAULT NULL;
-- ENUM values automatically sync with role_permissions.slug values
```

### How It Works

1. **Role Creation**: When a new role is created, the `user_type` ENUM is automatically updated
2. **Role Updates**: Slug changes trigger ENUM updates and user reassignments
3. **Role Deletion**: System checks for assigned users and provides reassignment guidance
4. **Orphaned User Detection**: Before ENUM updates, system finds and reassigns orphaned users
5. **Automatic Cleanup**: Invalid user_type values are automatically corrected

### Error Handling

The system provides comprehensive error handling for:
- Role deletion with assigned users (lists users and suggests reassignment)
- Orphaned users with invalid user_type values
- Data truncation errors during ENUM updates
- Detailed logging for troubleshooting

For complete documentation, see `/docs/ENUM_SYNC_SYSTEM.md`

## 🔄 Updates

Stay updated with the latest changes by:

1. Following the repository
2. Checking the releases page
3. Reading the changelog

```

---

**Happy Coding! 🎉**
