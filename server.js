require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   DATABASE CONNECTION
========================= */
const db = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Test DB connection
(async () => {
  try {
    const res = await db.query('SELECT NOW()');
    console.log('✅ DB Connected Successfully', res.rows[0]);
  } catch (err) {
    console.error('❌ DB Connection Failed:', err);
  }
})();

/* =========================
   HELPER FUNCTIONS
========================= */
const isExpired = (createdAt) => {
  const created = new Date(createdAt).getTime();
  return Date.now() - created > 2 * 60 * 60 * 1000; // 2 hours
};

/* =========================
   SIGNUP
========================= */
app.post('/signup', async (req, res) => {
  try {
    const { email, password, district } = req.body;
    if (!email || !password || !district)
      return res.json({ success: false, message: 'All fields required' });

    const existingUser = await db.query('SELECT id FROM users WHERE email=$1', [email]);
    if (existingUser.rows.length > 0)
      return res.json({ success: false, message: 'Email already exists' });

    await db.query(
      'INSERT INTO users (email, password, district) VALUES ($1, $2, $3)',
      [email, password, district]
    );

    res.json({ success: true, message: 'Signup successful' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   LOGIN
========================= */
app.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.json({ success: false, message: 'All fields required' });

    const result = await db.query('SELECT * FROM users WHERE email=$1', [email]);
    if (result.rows.length === 0)
      return res.json({ success: false, message: 'User not found' });

    const user = result.rows[0];
    if (user.password !== password)
      return res.json({ success: false, message: 'Invalid password' });

    res.json({
      success: true,
      message: 'Login successful',
      userId: user.id,
      district: user.district
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   CREATE GROUP
========================= */
app.post('/create-group', async (req, res) => {
  try {
    const { productId, productName, productPrice, userId } = req.body;
    if (!productId || !productName || !productPrice || !userId)
      return res.json({ success: false, message: 'All fields required' });

    const groupId = 'group-' + Date.now();

    await db.query(
      `INSERT INTO group_buys
       (group_id, product_name, product_price, product_id, created_at, status, created_by)
       VALUES ($1, $2, $3, $4, NOW(), 'pending', $5)`,
      [groupId, productName, productPrice, productId, userId]
    );

    res.json({ success: true, groupId });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   GET ALL ACTIVE GROUPS
========================= */
app.get('/all-groups', async (req, res) => {
  try {
    const results = await db.query(
      "SELECT * FROM group_buys WHERE status='pending' ORDER BY created_at DESC"
    );
    res.json({ success: true, groups: results.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   JOIN GROUP
========================= */
app.post('/join-group', async (req, res) => {
  try {
    const { groupId, memberName, deviceId, userId } = req.body;
    if (!groupId || !memberName || !deviceId)
      return res.json({ success: false, message: 'All fields required' });

    const groupRes = await db.query('SELECT * FROM group_buys WHERE group_id=$1', [groupId]);
    if (groupRes.rows.length === 0) return res.json({ success: false, message: 'Group not found' });

    const group = groupRes.rows[0];
    if (group.status !== 'pending') return res.json({ success: false, message: 'Group closed' });

    if (isExpired(group.created_at)) {
      await db.query("UPDATE group_buys SET status='expired' WHERE group_id=$1", [groupId]);
      return res.json({ success: false, message: 'Group expired' });
    }

    const deviceCheck = await db.query(
      'SELECT id FROM group_members WHERE group_id=$1 AND device_id=$2',
      [groupId, deviceId]
    );
    if (deviceCheck.rows.length > 0)
      return res.json({ success: false, message: 'Already joined from this device' });

    const nameCheck = await db.query(
      'SELECT id FROM group_members WHERE group_id=$1 AND member_name=$2',
      [groupId, memberName]
    );
    if (nameCheck.rows.length > 0)
      return res.json({ success: false, message: 'Name already joined' });

    await db.query(
      `INSERT INTO group_members
       (group_id, member_name, device_id, user_id, joined_at)
       VALUES ($1, $2, $3, $4, NOW())`,
      [groupId, memberName, deviceId, userId]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) FROM group_members WHERE group_id=$1',
      [groupId]
    );
    const count = parseInt(countResult.rows[0].count);

    if (count >= 3) {
      await db.query("UPDATE group_buys SET status='success' WHERE group_id=$1", [groupId]);
    }

    res.json({ success: true, members: count });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   GROUP STATUS
========================= */
app.get('/group-status/:groupId', async (req, res) => {
  try {
    const { groupId } = req.params;
    const groupRes = await db.query('SELECT * FROM group_buys WHERE group_id=$1', [groupId]);
    if (groupRes.rows.length === 0) return res.json({ success: false, message: 'Group not found' });

    let group = groupRes.rows[0];
    if (isExpired(group.created_at) && group.status === 'pending') {
      await db.query("UPDATE group_buys SET status='expired' WHERE group_id=$1", [groupId]);
      group.status = 'expired';
    }

    const membersRes = await db.query(
      'SELECT member_name FROM group_members WHERE group_id=$1',
      [groupId]
    );

    res.json({
      success: true,
      group: { ...group, members: membersRes.rows.map(m => ({ member_name: m.member_name })) }
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   PLACE ORDER
========================= */
app.post('/api/place-order', async (req, res) => {
  try {
    const { userId, cartItems, isGroupBuy } = req.body;
    if (!userId || !cartItems || cartItems.length === 0)
      return res.json({ success: false, message: 'Missing fields' });

    const userRes = await db.query('SELECT district FROM users WHERE id=$1', [userId]);
    if (userRes.rows.length === 0) return res.json({ success: false, message: 'User not found' });

    const userDistrict = userRes.rows[0].district;

    const couponRes = await db.query(
      'SELECT * FROM coupons WHERE LOWER(district)=LOWER($1) AND is_active=TRUE',
      [userDistrict]
    );

    let discountType = null, discountValue = 0;
    if (couponRes.rows.length > 0) {
      discountType = couponRes.rows[0].discount_type;
      discountValue = Number(couponRes.rows[0].discount_value);
    }

    for (let item of cartItems) {
      const quantity = Number(item.quantity);
      const price = Number(item.price);
      let originalTotal = price * quantity;
      let districtDiscount = 0;
      let groupDiscount = 0;
      let finalPrice = originalTotal;

      if (discountType === 'percentage') districtDiscount = (originalTotal * discountValue) / 100;
      if (discountType === 'flat') districtDiscount = discountValue;

      finalPrice -= districtDiscount;
      if (isGroupBuy) {
        groupDiscount = (finalPrice * 5) / 100;
        finalPrice -= groupDiscount;
      }
      if (finalPrice < 0) finalPrice = 0;

      await db.query(
        `INSERT INTO orders
         (user_id, product_id, quantity, original_price, district_discount, group_discount, total_price, is_groupbuy, status, order_date)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Placed',NOW())`,
        [userId, item.productId, quantity, originalTotal, districtDiscount, groupDiscount, finalPrice, isGroupBuy]
      );
    }

    if (isGroupBuy) {
      await db.query(
        `UPDATE group_buys SET status='completed' WHERE created_by=$1 AND status='success'`,
        [userId]
      );
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

/* =========================
   GET MY ORDERS
========================= */
app.get('/api/my-orders/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const results = await db.query(
      `SELECT orders.id, orders.quantity, orders.total_price, orders.status,
              orders.order_date, orders.is_groupbuy, products.product_name, products.image_url
       FROM orders
       LEFT JOIN products ON orders.product_id = products.id
       WHERE orders.user_id=$1
       ORDER BY orders.order_date DESC`,
      [userId]
    );
    res.json({ success: true, orders: results.rows });
  } catch (err) {
    res.status(500).json({ success: false });
  }
});

/* =========================
   DELETE ORDER
========================= */
app.delete('/api/delete-order/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;
    const result = await db.query('DELETE FROM orders WHERE id=$1', [orderId]);
    if (result.rowCount === 0)
      return res.json({ success: false, message: 'Order not found' });
    res.json({ success: true, message: 'Order deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

/* =========================
   START SERVER
========================= */
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
app.get("/", (req, res) => res.send("Backend is running 🚀"));