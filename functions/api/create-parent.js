// Cloudflare Pages Function — POST /api/create-parent
//
// Tạo 1 tài khoản Supabase Auth (email+password) cho phụ huynh. Việc này cần
// "service_role key" của Supabase (bỏ qua mọi RLS), tuyệt đối không được nhúng
// vào file tĩnh (index.html/QuanLyTuVung.html) vì ai cũng đọc được code frontend.
// Đây là lý do hàm này tồn tại: chạy trên server của Cloudflare, giữ key bí mật
// trong biến môi trường (secret) chứ không trong code.
//
// Cách cấu hình secret (làm 1 lần, thủ công, KHÔNG qua code):
//   Cloudflare Pages project -> Settings -> Environment variables ->
//   thêm SUPABASE_SERVICE_ROLE_KEY (lấy ở Supabase Dashboard -> Project Settings -> API).
//
// Không dùng supabase-js SDK ở đây (project này chủ trương không có build step/
// npm dependency) — gọi thẳng REST API (GoTrue + PostgREST) của Supabase bằng fetch().

const SUPABASE_URL = "https://vuykuqmebmainyhiotfx.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_8Ro-jEFQqFh7EfbXPfzWaw_V1xrkoyU";

export async function onRequestPost(context) {
  const { request, env } = context;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!serviceRoleKey) {
    return jsonResponse({ error: "Server chưa cấu hình SUPABASE_SERVICE_ROLE_KEY." }, 500);
  }

  const authHeader = request.headers.get("Authorization") || "";
  const callerToken = authHeader.replace(/^Bearer\s+/i, "");
  if (!callerToken) {
    return jsonResponse({ error: "Thiếu Authorization header." }, 401);
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Body không hợp lệ (cần JSON)." }, 400);
  }
  const email = String(body.email || "").trim();
  const password = String(body.password || "");
  if (!email || password.length < 6) {
    return jsonResponse({ error: "Cần email hợp lệ và mật khẩu tối thiểu 6 ký tự." }, 400);
  }

  // 1. Xác định người gọi là ai. Lưu ý: header "apikey" PHẢI là anon key cố định của
  //    project (Supabase Gateway/Kong kiểm tra header này khớp đúng 1 trong các key
  //    cấu hình sẵn — anon hoặc service_role — chứ không chấp nhận JWT của user ở đây).
  //    Token đăng nhập của người gọi chỉ đi trong Authorization để GoTrue xác định danh tính.
  const callerRes = await fetch(`${SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${callerToken}` }
  });
  if (!callerRes.ok) {
    return jsonResponse({ error: "Không xác thực được người gọi." }, 401);
  }
  const caller = await callerRes.json();

  // 2. Kiểm tra người gọi có trong bảng admins không — dùng service_role để đọc,
  //    bỏ qua RLS, vì đây là bước kiểm tra quyền, không nên phụ thuộc RLS của admins.
  const adminCheckRes = await fetch(
    `${SUPABASE_URL}/rest/v1/admins?user_id=eq.${encodeURIComponent(caller.id)}&select=user_id`,
    { headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` } }
  );
  const adminRows = adminCheckRes.ok ? await adminCheckRes.json() : [];
  if (!adminRows.length) {
    return jsonResponse({ error: "Chỉ admin mới được tạo tài khoản phụ huynh." }, 403);
  }

  // 3. Tạo tài khoản Auth mới (Admin API — GoTrue), xác nhận email sẵn (không cần verify).
  const createRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users`, {
    method: "POST",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ email, password, email_confirm: true })
  });
  const created = await createRes.json();
  if (!createRes.ok) {
    return jsonResponse({ error: created.msg || created.error_description || "Tạo tài khoản thất bại." }, createRes.status);
  }

  // 4. Trigger handle_new_user() đã tự tạo dòng profiles mặc định role='student' —
  //    cập nhật lại thành 'parent' (service_role bỏ qua RLS "user update own profile").
  //    Dùng return=representation + kiểm tra mảng trả về có phần tử không — với
  //    return=minimal, PostgREST trả 204 (ok=true) dù khớp 0 hay 1 dòng, sẽ báo
  //    "thành công" giả nếu dòng profiles chưa kịp tạo xong lúc PATCH chạy tới.
  const patchRes = await fetch(`${SUPABASE_URL}/rest/v1/profiles?id=eq.${created.id}`, {
    method: "PATCH",
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      "Content-Type": "application/json",
      Prefer: "return=representation"
    },
    body: JSON.stringify({ role: "parent" })
  });
  if (!patchRes.ok) {
    const err = await patchRes.text();
    return jsonResponse({ error: "Tạo tài khoản OK nhưng gán vai trò 'parent' thất bại: " + err }, 500);
  }
  const patched = await patchRes.json();
  if (!Array.isArray(patched) || patched.length === 0) {
    return jsonResponse({ error: "Tạo tài khoản OK nhưng không tìm thấy dòng profiles để gán vai trò 'parent' — thử liên kết lại sau vài giây, hoặc kiểm tra tay trong Supabase." }, 500);
  }

  return jsonResponse({ userId: created.id });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
