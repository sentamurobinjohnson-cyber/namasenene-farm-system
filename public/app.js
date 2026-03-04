const API =
  window.location.hostname === "localhost"
    ? "http://localhost:8080"
    : "https://namasenene-farm-system-production-c6e2.up.railway.app";

function qs(id){ return document.getElementById(id); }

async function api(path, options = {}) {
  const token = localStorage.getItem("token");
  if (!token) {
    window.location.href = "login.html";
    return;
  }

  const fetchOptions = {
    method: options.method || "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  };

  // JSON body support
  if (options.body !== undefined) {
    fetchOptions.headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify(options.body);
  }

  const res = await fetch(`${API}${path}`, fetchOptions);

  // Handle expired/invalid token
  if (res.status === 401) {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    window.location.href = "login.html";
    return;
  }

  // 204 No Content (common on DELETE)
  if (res.status === 204) return null;

  // Try JSON, else text
  const contentType = res.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await res.json().catch(() => ({}))
    : await res.text().catch(() => "");

  if (!res.ok) {
    const msg = (data && data.error) ? data.error : (typeof data === "string" ? data : "Request failed");
    throw new Error(msg);
  }

  return data;

}


