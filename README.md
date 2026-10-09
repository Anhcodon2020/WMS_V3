# WMS_V3 - React + MySQL Connector

Dự án này tạo sẵn 1 công cụ mini để test kết nối MySQL của AiveCloud từ React frontend và Node.js backend.

## Cấu trúc

- [server/index.js](server/index.js): API backend kết nối MySQL
- [client/src/main.jsx](client/src/main.jsx): giao diện React
- [client/src/styles.css](client/src/styles.css): giao diện styling
- [package.json](package.json): script chạy tổng

## Cài đặt Node.js

Nếu máy bạn chưa có Node.js, hãy cài bản LTS từ:

https://nodejs.org/

Sau khi cài xong, kiểm tra:

```bash
node -v
npm -v
```

## Chạy project

Từ thư mục dự án:

```bash
npm install --prefix server
npm install --prefix client
npm run dev
```

Sau đó mở:

- Frontend: http://localhost:5175
- Backend API: http://localhost:3005/api/health

## Thông tin kết nối MySQL AiveCloud

Với Aiven, bạn sẽ dùng cấu hình như sau:

- Host: hostname Aiven MySQL
- Port: 21065
- User: avnadmin
- Database: wms_db
- SSL: bắt buộc

Nếu bạn có chuỗi URL dạng:

```text
mysql://username:password@host:port/database?ssl-mode=REQUIRED
```

thì backend sẽ tự parse đúng các giá trị và bật SSL.

Sau đó bấm Test Connection.

## Ghi chú quan trọng

Do AiveCloud thường yêu cầu:

- mở port MySQL từ firewall / security group
- cho phép IP máy hiện tại truy cập DB
- hoặc sử dụng SSH tunnel / private network nếu dữ liệu nằm private

Nếu cần, tôi có thể tiếp tục viết tiếp cho bạn:

1. Kết nối database theo chuẩn React + API
2. Hiển thị danh sách bảng / data grid
3. Tạo form CRUD cho WMS
4. Tích hợp login, role, và xử lý lỗi production
