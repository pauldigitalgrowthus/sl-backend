const { getMySQLConnection } = require('../../config/mysql');
const { makeApiRequest, queryQb } = require('./quickbooks.client');

/**
 * Format Vendor Display Name safely for QuickBooks Online API
 */
const formatVendorName = (artistUser) => {
  const firstName = (artistUser.first_name || artistUser.firstName || '').trim();
  const lastName = (artistUser.last_name || artistUser.lastName || '').trim();
  const email = (artistUser.email || '').trim();
  const id = artistUser.id;

  if (firstName && lastName) {
    return `${firstName} ${lastName}`;
  } else if (firstName) {
    return firstName;
  } else if (email) {
    return email.split('@')[0];
  }
  return `Artist ${id}`;
};

/**
 * Query QuickBooks API to find existing Vendor by Email or Display Name
 */
const findVendorInQb = async (realmId, { email, displayName }) => {
  // 1. Try finding by DisplayName (primary unique identifier in QuickBooks Online)
  if (displayName) {
    const cleanName = displayName.replace(/'/g, "\\'");
    try {
      const nameQueryResult = await queryQb(realmId, `SELECT * FROM Vendor WHERE DisplayName = '${cleanName}'`);
      const vendorsByName = nameQueryResult?.Vendor || [];
      if (vendorsByName.length > 0) {
        return vendorsByName[0];
      }
    } catch (err) {
      console.warn('⚠️ Vendor query by DisplayName error:', err.message);
    }
  }

  // 2. In QuickBooks Online API, PrimaryEmailAddr is a nested object and not queryable in WHERE clause.
  // If email is provided, scan active vendors and match PrimaryEmailAddr in memory.
  if (email) {
    try {
      const emailQueryResult = await queryQb(realmId, `SELECT * FROM Vendor WHERE Active = true MAXRESULTS 1000`);
      const vendors = emailQueryResult?.Vendor || [];
      const match = vendors.find(v => v.PrimaryEmailAddr?.Address?.toLowerCase() === email.toLowerCase());
      if (match) {
        return match;
      }
    } catch (err) {
      console.warn('⚠️ Vendor query by email scan error:', err.message);
    }
  }

  return null;
};

/**
 * Create a new Vendor in QuickBooks Online
 */
const createVendorInQb = async (realmId, artistUser) => {
  let displayName = formatVendorName(artistUser);
  const firstName = (artistUser.first_name || artistUser.firstName || '').trim();
  const lastName = (artistUser.last_name || artistUser.lastName || '').trim();
  const email = (artistUser.email || '').trim();

  // Try creating with standard displayName. If name collision happens, append artist ID
  let vendorPayload = {
    GivenName: firstName || undefined,
    FamilyName: lastName || undefined,
    DisplayName: displayName,
    PrimaryEmailAddr: email ? { Address: email } : undefined
  };

  try {
    const result = await makeApiRequest(realmId, {
      method: 'POST',
      url: '/vendor',
      data: vendorPayload
    });

    return result?.Vendor;
  } catch (err) {
    // If DisplayName is duplicate in QB, try with unique suffix
    if (err.message.includes('Duplicate Name') || err.message.includes('already exists')) {
      const uniqueDisplayName = `${displayName} (${artistUser.id})`;
      vendorPayload.DisplayName = uniqueDisplayName;

      const retryResult = await makeApiRequest(realmId, {
        method: 'POST',
        url: '/vendor',
        data: vendorPayload
      });

      return retryResult?.Vendor;
    }
    throw err;
  }
};

/**
 * Find or Create QuickBooks Vendor for an Artist / User.
 * Strictly Idempotent.
 *
 * @param {string} realmId - QuickBooks realmId / company ID
 * @param {object} artistUser - User object containing id, email, first_name, last_name
 */
const findOrCreateVendor = async (realmId, artistUser) => {
  if (!artistUser || !artistUser.id) {
    throw new Error('Valid artist/user object is required to resolve QuickBooks vendor');
  }

  const mysql = getMySQLConnection();

  // 1. Check local mapping table for user_id
  const [mappings] = await mysql.execute(
    `SELECT * FROM quickbooks_vendor_mappings WHERE user_id = ? LIMIT 1`,
    [artistUser.id]
  );

  if (mappings.length > 0 && mappings[0].quickbooks_vendor_id) {
    const storedVendorId = mappings[0].quickbooks_vendor_id;
    // Verify vendor still exists in QB
    try {
      const qbVendor = await getVendorById(realmId, storedVendorId);
      if (qbVendor) {
        return {
          vendorId: storedVendorId,
          vendor: qbVendor,
          isNew: false
        };
      }
    } catch (err) {
      console.warn(`⚠️ Mapped QB Vendor ${storedVendorId} not found in QB, searching again...`);
    }
  }

  const displayName = formatVendorName(artistUser);
  const email = artistUser.email;

  // 2. Search in QuickBooks Online API
  let qbVendor = await findVendorInQb(realmId, { email, displayName });
  let isNew = false;

  // 3. If not found in QB, create vendor in QB
  if (!qbVendor) {
    console.log(`➕ Creating new QuickBooks Vendor for Artist ID ${artistUser.id} (${displayName})...`);
    qbVendor = await createVendorInQb(realmId, artistUser);
    isNew = true;
  }

  const qbVendorId = String(qbVendor.Id);

  // 4. Save/Update local mapping database
  await mysql.execute(
    `INSERT INTO quickbooks_vendor_mappings (user_id, quickbooks_vendor_id, display_name)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
      quickbooks_vendor_id = VALUES(quickbooks_vendor_id),
      display_name = VALUES(display_name),
      updated_at = NOW()`,
    [artistUser.id, qbVendorId, qbVendor.DisplayName]
  );

  return {
    vendorId: qbVendorId,
    vendor: qbVendor,
    isNew
  };
};

/**
 * Get Vendor by ID from QuickBooks
 */
const getVendorById = async (realmId, vendorId) => {
  const data = await makeApiRequest(realmId, {
    method: 'GET',
    url: `/vendor/${vendorId}`
  });
  return data?.Vendor || null;
};

module.exports = {
  findVendorInQb,
  createVendorInQb,
  findOrCreateVendor,
  getVendorById,
  formatVendorName
};
