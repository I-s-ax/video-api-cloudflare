const API = window.APP_CONFIG.API_BASE.replace(/\/$/,"");
const $ = id => document.getElementById(id);
let token = sessionStorage.getItem("admin_token") || "";
async function api(path, options={}) {
  const headers = {"Content-Type":"application/json", ...(options.headers||{})};
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(API+path,{...options,headers});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || `HTTP_${res.status}`);
  return data;
}
function showDashboard(show) {
  $("login").classList.toggle("hidden",show);
  $("dashboard").classList.toggle("hidden",!show);
}
async function login() {
  try {
    const data = await api("/auth/login",{method:"POST",body:JSON.stringify({email:$("email").value,password:$("password").value,device_label:"Admin web"})});
    if (data.user.role !== "admin") throw new Error("ADMIN_REQUIRED");
    token = data.token; sessionStorage.setItem("admin_token",token);
    showDashboard(true); await loadUsers();
  } catch(e) {$("loginMsg").textContent=e.message;}
}
async function loadUsers() {
  try {
    const data = await api("/admin/users");
    $("users").innerHTML = "";
    for (const u of data.users) {
      const tr = document.createElement("tr");
      const email = document.createElement("td"); email.textContent=u.email;
      const status = document.createElement("td"); status.textContent=u.status;
      const date = document.createElement("td"); date.textContent=new Date(u.created_at*1000).toLocaleString();
      const actions = document.createElement("td"); actions.className="actions";
      if (u.role !== "admin") {
        for (const [action,label] of [["approve","Aprobar"],["reject","Rechazar"],["suspend","Suspender"],["revoke","Revocar"]]) {
          const b=document.createElement("button"); b.textContent=label;
          if(action!=="approve") b.className="danger";
          b.onclick=async()=>{try{await api(`/admin/users/${u.id}/${action}`,{method:"POST",body:"{}"});await loadUsers();}catch(e){$("msg").textContent=e.message;}};
          actions.appendChild(b);
        }
      }
      tr.append(email,status,date,actions); $("users").appendChild(tr);
    }
    $("msg").textContent=`${data.users.length} usuarios mostrados (máximo 200).`;
  } catch(e) {$("msg").textContent=e.message;if(e.message==="UNAUTHORIZED") logout();}
}
function logout(){token="";sessionStorage.removeItem("admin_token");showDashboard(false);}
$("loginBtn").onclick=login;$("refresh").onclick=loadUsers;$("logout").onclick=logout;
if(token){api("/auth/me").then(u=>{if(u.role==="admin"){showDashboard(true);loadUsers();}else logout();}).catch(logout);}
