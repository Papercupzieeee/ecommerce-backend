const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   DATABASE CONNECTION
========================= */

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME
});

/* =========================
   HELPER FUNCTION
========================= */

function isExpired(createdAt) {
  const created = new Date(createdAt).getTime();
  return Date.now() - created > 2 * 60 * 60 * 1000;
}

/* =========================
   SIGNUP
========================= */

app.post('/signup', (req, res) => {

  const { email, password, district } = req.body;

  if (!email || !password || !district)
    return res.json({ success: false, message: 'All fields required' });

  db.query('SELECT id FROM users WHERE email=?', [email], (err, result) => {

    if (err)
      return res.status(500).json({ success: false, message: err.message });

    if (result.length > 0)
      return res.json({ success: false, message: 'Email already exists' });

    db.query(
      'INSERT INTO users (email, password, district) VALUES (?, ?, ?)',
      [email, password, district],
      err => {

        if (err)
          return res.status(500).json({ success: false, message: err.message });

        res.json({ success: true, message: 'Signup successful' });
      }
    );
  });
});
/* =========================
   LOGIN
========================= */

app.post('/login', (req, res) => {

  const { email, password } = req.body;

  if (!email || !password)
    return res.json({ success: false, message: 'All fields required' });

  db.query('SELECT * FROM users WHERE email=?', [email], (err, result) => {

    if (err)
      return res.status(500).json({ success: false, message: err.message });

    if (result.length === 0 || result[0].password !== password)
      return res.json({ success: false, message: 'Invalid credentials' });

    
    res.json({
  success: true,
  message: 'Login successful',
  userId: result[0].id,
  district: result[0].district   
});

  });
});
/* =========================
   CREATE GROUP
========================= */

app.post('/create-group', (req, res) => {

    const { productId, productName, productPrice, userId } = req.body;

    const checkSql = `
        SELECT * FROM group_buys 
        WHERE product_id = ? 
        AND status = 'pending'
        AND created_by = ?   -- ⭐ IMPORTANT
        AND created_at >= NOW() - INTERVAL 2 HOUR
        LIMIT 1
    `;

    db.query(checkSql, [productId, userId], (err, result) => {

        if (result.length > 0) {
            return res.json({
                success: true,
                groupId: result[0].id
            });
        }

        const insertSql = `
            INSERT INTO group_buys 
            (product_id, product_name, product_price, created_at, status, created_by)
            VALUES (?, ?, ?, NOW(), 'pending', ?)
        `;

        db.query(insertSql, [productId, productName, productPrice, userId], (err, insertResult) => {

            res.json({
                success: true,
                groupId: insertResult.insertId
            });
        });

    });
});
/* =========================
   JOIN GROUP
========================= */

app.post('/join-group', (req, res) => {

  const { groupId, memberName, deviceId, userId } = req.body;

  if (!groupId || !memberName || !deviceId)
    return res.json({ success: false, message: 'All fields required' });

  // ✅ USE id NOT group_id
  db.query('SELECT * FROM group_buys WHERE id=?', [groupId], (err, result) => {

    if (err)
      return res.status(500).json({ success: false, message: err.message });

    if (result.length === 0)
      return res.json({ success: false, message: 'Group not found' });

    const group = result[0];

    if (group.status !== 'pending')
      return res.json({ success: false, message: 'Group closed' });

    if (isExpired(group.created_at)) {

      db.query("UPDATE group_buys SET status='expired' WHERE id=?", [groupId]);

      return res.json({ success: false, message: 'Group expired' });
    }

    // Device check
    db.query(
      'SELECT id FROM group_members WHERE group_id=? AND device_id=?',
      [groupId, deviceId],
      (err, deviceCheck) => {

        if (err)
          return res.status(500).json({ success: false, message: err.message });

        if (deviceCheck.length > 0)
          return res.json({ success: false, message: 'Already joined from this device' });

        // Name check
        db.query(
          'SELECT id FROM group_members WHERE group_id=? AND member_name=?',
          [groupId, memberName],
          (err, nameCheck) => {

            if (err)
              return res.status(500).json({ success: false, message: err.message });

            if (nameCheck.length > 0)
              return res.json({ success: false, message: 'Name already joined' });

            // Insert member
            db.query(
              `INSERT INTO group_members 
              (group_id, member_name, device_id, user_id, joined_at) 
              VALUES (?, ?, ?, ?, NOW())`,
              [groupId, memberName, deviceId, userId],
              err => {

                if (err)
                  return res.status(500).json({ success: false, message: err.message });

                // Count members
                db.query(
                  'SELECT COUNT(*) AS count FROM group_members WHERE group_id=?',
                  [groupId],
                  (err, countResult) => {

                    if (err)
                      return res.status(500).json({ success: false, message: err.message });

                    const count = countResult[0].count;

                    if (count >= 3) {
                      db.query(
                        "UPDATE group_buys SET status='success' WHERE id=?",
                        [groupId]
                      );
                    }

                    res.json({ success: true, members: count });
                  }
                );
              }
            );
          }
        );
      }
    );
  });
});

/* =========================
   GROUP STATUS
========================= */

app.get('/group-status/:groupId', (req, res) => {

  const groupId = req.params.groupId;

  db.query(
    'SELECT * FROM group_buys WHERE id=?',
    [groupId],
    (err, groupResult) => {

      if (err)
        return res.status(500).json({ success: false, message: err.message });

      if (groupResult.length === 0)
        return res.json({ success: false, message: 'Group not found' });

      const group = groupResult[0];

      if (isExpired(group.created_at) && group.status === 'pending') {

        db.query(
          "UPDATE group_buys SET status='expired' WHERE id=?",
          [groupId]
        );

        group.status = 'expired';
      }

      db.query(
        'SELECT member_name FROM group_members WHERE group_id=?',
        [groupId],
        (err, membersResult) => {

          if (err)
            return res.status(500).json({ success: false, message: err.message });

          res.json({
            success: true,
            group: {
              ...group,
              members: membersResult.map(m => ({
                member_name: m.member_name
              }))
            }
          });
        }
      );
    }
  );
});

app.post("/api/place-order", (req, res) => {

    const { userId, cartItems, isGroupBuy } = req.body;

    if (!userId || !cartItems || cartItems.length === 0) {
        return res.json({ success: false, message: "Missing fields" });
    }

    db.query(
        "SELECT district FROM users WHERE id = ?",
        [userId],
        (err, userResult) => {

            if (err || userResult.length === 0) {
                return res.json({ success: false, message: "User not found" });
            }

            const userDistrict = userResult[0].district;

            db.query(
                "SELECT * FROM coupons WHERE LOWER(district)=LOWER(?) AND is_active=1",
                [userDistrict],
                (err, couponResult) => {

                    let discountType = null;
                    let discountValue = 0;

                    if (!err && couponResult.length > 0) {
                        discountType = couponResult[0].discount_type;
                        discountValue = Number(couponResult[0].discount_value);
                    }

                    let completed = 0;

                    cartItems.forEach(item => {

                        let quantity = Number(item.quantity);
                        let price = Number(item.price);

                        let originalTotal = price * quantity;
                        let districtDiscount = 0;
                        let groupDiscount = 0;
                        let finalPrice = originalTotal;

                        // 🎯 District Coupon
                        if (discountType === "percentage") {
                            districtDiscount = (originalTotal * discountValue) / 100;
                        }

                        if (discountType === "flat") {
                            districtDiscount = discountValue;
                        }

                        finalPrice -= districtDiscount;

                        // 🎯 GroupBuy Discount (Example: 5%)
                        if (isGroupBuy) {
                            groupDiscount = (finalPrice * 5) / 100;
                            finalPrice -= groupDiscount;
                        }

                        if (finalPrice < 0) finalPrice = 0;

                        db.query(
                            `INSERT INTO orders
                            (user_id, product_id, quantity,
                             original_price, district_discount,
                             group_discount, total_price,
                             is_groupbuy, status, order_date)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'Placed', NOW())`,
                            [
                                userId,
                                item.productId,
                                quantity,
                                originalTotal,
                                districtDiscount,
                                groupDiscount,
                                finalPrice,
                                isGroupBuy ? 1 : 0
                            ],
                            () => {

                                completed++;

                                if (completed === cartItems.length) {
                                    res.json({ success: true });
                                }
                            }
                        );

                    });

                }
            );

        }
    );
});
app.get("/api/my-orders/:userId", (req, res) => {

    const userId = req.params.userId;

    db.query(
    `SELECT 
        orders.id,
        orders.quantity,
        orders.total_price,
        orders.status,
        orders.order_date,
        orders.is_groupbuy,
        products.product_name,
        products.image_url
     FROM orders
     LEFT JOIN products 
        ON orders.product_id = products.id
     WHERE orders.user_id = ?
     ORDER BY orders.order_date DESC`,
    [userId],
    (err, results) => {

        if (err) {
            console.log(err);
            return res.json({ success: false });
        }

        res.json({
            success: true,
            orders: results
        });

    });

});
// DELETE ORDER
app.delete("/api/delete-order/:orderId", (req, res) => {
    const orderId = req.params.orderId;

    db.query("DELETE FROM orders WHERE id = ?", [orderId], (err, result) => {
        if (err) {
            console.log("DELETE ORDER ERROR:", err);
            return res.json({ success: false, message: "Server error" });
        }

        if (result.affectedRows === 0) {
            return res.json({ success: false, message: "Order not found" });
        }

        res.json({ success: true, message: "Order deleted successfully" });
    });
});

/* =========================
   START SERVER
========================= */

app.listen(process.env.PORT, () => {
  console.log(`🚀 Server running at http://localhost:${process.env.PORT}`);
});