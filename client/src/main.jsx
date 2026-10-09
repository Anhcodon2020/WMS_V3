import React from 'react';
import ReactDOM from 'react-dom/client';
import './styles.css';


function App() {
  const [form, setForm] = React.useState(initialForm);
  const [rows, setRows] = React.useState(inboundData);

  const handleChange = (event) => {
    const { name, value } = event.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (event) => {
    event.preventDefault();

    const newRow = {
      id: form.inboundNo || `IN-${Date.now()}`,
      supplier: form.supplier,
      po: form.po,
      item: form.itemName,
      sku: form.sku,
      qty: Number(form.quantity) || 0,
      received: 0,
      unit: form.unit,
      warehouse: form.warehouse,
      status: form.status,
      date: form.receivedDate,
      priority: 'Trung bình'
    };

    setRows((prev) => [newRow, ...prev]);
    setForm(initialForm);
  };

  const stats = [
    { label: 'Tổng phiếu nhập', value: rows.length, tone: 'blue' },
    { label: 'Đang nhập', value: rows.filter((item) => item.status === 'Đang nhập').length, tone: 'amber' },
    { label: 'Hoàn thành', value: rows.filter((item) => item.status === 'Hoàn thành').length, tone: 'green' },
    { label: 'Chờ kiểm hàng', value: rows.filter((item) => item.status === 'Chờ kiểm hàng').length, tone: 'red' }
  ];

  return (
    <div className="inbound-page">
      <header className="topbar">
        <div>
          <p className="eyebrow">Warehouse Management System</p>
          <h1>Inbound Management</h1>
        </div>
        <button className="primary-btn">+ Tạo phiếu nhập</button>
      </header>

      <section className="stats-grid">
        {stats.map((stat) => (
          <div key={stat.label} className={`stat-card ${stat.tone}`}>
            <span>{stat.label}</span>
            <strong>{stat.value}</strong>
          </div>
        ))}
      </section>

      <section className="content-grid">
        <form className="card form-card" onSubmit={handleSubmit}>
          <div className="card-header">
            <h2>Thông tin nhập kho</h2>
          </div>

          <div className="field-grid">
            <label>
              Mã phiếu nhập
              <input name="inboundNo" value={form.inboundNo} onChange={handleChange} />
            </label>
            <label>
              Nhà cung cấp
              <input name="supplier" value={form.supplier} onChange={handleChange} />
            </label>
            <label>
              Số PO
              <input name="po" value={form.po} onChange={handleChange} />
            </label>
            <label>
              Mã SKU
              <input name="sku" value={form.sku} onChange={handleChange} />
            </label>
            <label className="full-span">
              Tên hàng hóa
              <input name="itemName" value={form.itemName} onChange={handleChange} />
            </label>
            <label>
              Số lượng
              <input name="quantity" value={form.quantity} onChange={handleChange} />
            </label>
            <label>
              Đơn vị
              <input name="unit" value={form.unit} onChange={handleChange} />
            </label>
            <label>
              Kho nhận
              <select name="warehouse" value={form.warehouse} onChange={handleChange}>
                <option value="WH-A">WH-A</option>
                <option value="WH-B">WH-B</option>
                <option value="WH-C">WH-C</option>
              </select>
            </label>
            <label>
              Ngày nhận
              <input type="date" name="receivedDate" value={form.receivedDate} onChange={handleChange} />
            </label>
            <label>
              Trạng thái
              <select name="status" value={form.status} onChange={handleChange}>
                <option value="Đang nhập">Đang nhập</option>
                <option value="Chờ kiểm hàng">Chờ kiểm hàng</option>
                <option value="Hoàn thành">Hoàn thành</option>
              </select>
            </label>
          </div>

          <div className="form-actions">
            <button type="submit" className="primary-btn">Lưu phiếu nhập</button>
            <button type="button" className="ghost-btn" onClick={() => setForm(initialForm)}>Xóa</button>
          </div>
        </form>

        <aside className="card summary-card">
          <div className="card-header">
            <h2>Nhật ký nhập kho</h2>
          </div>
          <ul className="timeline">
            <li>
              <span className="dot green" />
              <div>
                <strong>08:30</strong>
                <p>Đã xác nhận PO-1804 từ CTY TNHH ABC</p>
              </div>
            </li>
            <li>
              <span className="dot blue" />
              <div>
                <strong>09:15</strong>
                <p>Container hàng đến kho WH-B</p>
              </div>
            </li>
            <li>
              <span className="dot amber" />
              <div>
                <strong>10:10</strong>
                <p>Đang kiểm đếm lô hàng Kệ đựng hàng</p>
              </div>
            </li>
          </ul>
        </aside>
      </section>

      <section className="card table-card">
        <div className="card-header">
          <h2>Bảng inbound</h2>
          <button className="ghost-btn small">Xuất Excel</button>
        </div>

        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Mã phiếu</th>
                <th>Nhà cung cấp</th>
                <th>Số PO</th>
                <th>Hàng hóa</th>
                <th>SKU</th>
                <th>SL</th>
                <th>Đã nhận</th>
                <th>Kho</th>
                <th>Trạng thái</th>
                <th>Ngày</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.id}</td>
                  <td>{row.supplier}</td>
                  <td>{row.po}</td>
                  <td>{row.item}</td>
                  <td>{row.sku}</td>
                  <td>{row.qty}</td>
                  <td>{row.received}</td>
                  <td>{row.warehouse}</td>
                  <td>
                    <span className={`status-badge ${row.status.toLowerCase().replace(/\s+/g, '-')}`}>
                      {row.status}
                    </span>
                  </td>
                  <td>{row.date}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
