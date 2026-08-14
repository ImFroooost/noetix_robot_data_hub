import { useEffect, useState, type FormEvent } from "react";
import { api } from "../api";
import { useAuth } from "../auth";
import type { Role, User } from "../types";
import { ROLE_LABEL } from "../types";

export function UsersPage() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [error, setError] = useState("");

  const reload = () => api.listUsers().then(setUsers);

  useEffect(() => {
    if (!isAdmin) return;
    reload().catch((e) => setError(e.message));
  }, [isAdmin]);

  if (!isAdmin) return <div className="page error">需要管理员权限</div>;

  const onCreate = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    try {
      await api.createUser({
        username: fd.get("username"),
        password: fd.get("password"),
        role: fd.get("role"),
      });
      e.currentTarget.reset();
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "创建失败");
    }
  };

  return (
    <div className="page stack">
      <div className="card stack">
        <h1>用户管理</h1>
        {error && <div className="error">{error}</div>}
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>用户名</th>
              <th>角色</th>
              <th>状态</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.id}</td>
                <td>{u.username}</td>
                <td>
                  <select
                    value={u.role}
                    onChange={async (e) => {
                      await api.updateUser(u.id, { role: e.target.value as Role });
                      await reload();
                    }}
                  >
                    {(["admin", "editor", "viewer"] as Role[]).map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </td>
                <td>{u.is_active ? "启用" : "禁用"}</td>
                <td>
                  <button
                    className="secondary"
                    onClick={async () => {
                      await api.updateUser(u.id, { is_active: !u.is_active });
                      await reload();
                    }}
                  >
                    {u.is_active ? "禁用" : "启用"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <form className="card stack" style={{ maxWidth: 480 }} onSubmit={onCreate}>
        <h2>新建用户</h2>
        <label>
          用户名
          <input name="username" required />
        </label>
        <label>
          密码
          <input name="password" type="password" required />
        </label>
        <label>
          角色
          <select name="role" defaultValue="editor">
            <option value="admin">管理员</option>
            <option value="editor">编辑者</option>
            <option value="viewer">只读</option>
          </select>
        </label>
        <button type="submit">创建</button>
      </form>
    </div>
  );
}
