package com.webprint.client;

import android.content.Context;
import android.content.SharedPreferences;
import android.text.TextUtils;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 服务器地址的持久化存储。
 *
 * <p>薄壳客户端本身不含业务逻辑，只需要记住用户填写的服务器地址（一台机器一个地址）
 * 以及当前使用哪一个。数据用 {@link SharedPreferences} 保存，内容是一个 JSON 数组：
 *
 * <pre>[{"url":"https://print.example.com","name":"机房三楼"}]</pre>
 *
 * <p>仅使用框架自带的 {@code org.json}，不引入任何第三方依赖。
 */
public final class ServerStore {

    private static final String PREFS_NAME = "webprint_servers";
    private static final String KEY_SERVERS = "servers";
    private static final String KEY_ACTIVE = "active_index";

    private final SharedPreferences prefs;

    public ServerStore(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** 一条服务器记录。 */
    public static final class Server {
        public final String url;
        public final String name;

        public Server(String url, String name) {
            this.url = url;
            this.name = name == null ? "" : name;
        }

        /** 用于列表展示：优先显示名称，未命名时回退到地址。 */
        public String displayName(String fallback) {
            return TextUtils.isEmpty(name) ? fallback : name;
        }

        @Override
        public String toString() {
            return url;
        }
    }

    // ------------------------------------------------------------------
    // 查询
    // ------------------------------------------------------------------

    /** 读取全部已保存的服务器（按添加顺序）。数据损坏时返回空列表而不是崩溃。 */
    public List<Server> list() {
        List<Server> result = new ArrayList<>();
        String raw = prefs.getString(KEY_SERVERS, null);
        if (TextUtils.isEmpty(raw)) {
            return result;
        }
        try {
            JSONArray array = new JSONArray(raw);
            for (int i = 0; i < array.length(); i++) {
                JSONObject item = array.optJSONObject(i);
                if (item == null) {
                    continue;
                }
                String url = normalizeUrl(item.optString("url", ""));
                if (url == null) {
                    continue; // 跳过损坏或非法的记录
                }
                result.add(new Server(url, item.optString("name", "")));
            }
        } catch (Exception e) {
            // 解析失败：当作没有数据，避免启动即崩溃
        }
        return result;
    }

    public boolean isEmpty() {
        return list().isEmpty();
    }

    /** 当前激活的服务器；没有服务器时返回 {@code null}。索引越界自动回落到第 0 个。 */
    public Server getActive() {
        List<Server> all = list();
        if (all.isEmpty()) {
            return null;
        }
        int index = prefs.getInt(KEY_ACTIVE, 0);
        if (index < 0 || index >= all.size()) {
            index = 0;
        }
        return all.get(index);
    }

    /** 当前激活服务器的下标，无服务器时为 -1。 */
    public int getActiveIndex() {
        List<Server> all = list();
        if (all.isEmpty()) {
            return -1;
        }
        int index = prefs.getInt(KEY_ACTIVE, 0);
        return (index < 0 || index >= all.size()) ? 0 : index;
    }

    // ------------------------------------------------------------------
    // 修改
    // ------------------------------------------------------------------

    /**
     * 添加一个服务器。
     *
     * @param url  任意用户输入（{@code 192.168.1.100:3000} 这类省略协议的写法也可以）
     * @param name 显示名称，可为空
     * @return 新服务器的下标
     * @throws IllegalArgumentException 地址非法，或该地址已存在（调用方据此提示中文错误）
     */
    public int add(String url, String name) {
        String normalized = normalizeUrl(url);
        if (normalized == null) {
            throw new IllegalArgumentException("invalid url: " + url);
        }
        List<Server> all = list();
        for (Server existing : all) {
            if (existing.url.equalsIgnoreCase(normalized)) {
                throw new IllegalArgumentException("duplicate url: " + normalized);
            }
        }
        all.add(new Server(normalized, name == null ? "" : name.trim()));
        persist(all);
        int index = all.size() - 1;
        // 第一个添加的服务器自动成为当前服务器
        if (all.size() == 1) {
            setActive(index);
        }
        return index;
    }

    /** 删除指定下标的服务器，并把激活下标修正到合法范围。 */
    public void remove(int index) {
        List<Server> all = list();
        if (index < 0 || index >= all.size()) {
            return;
        }
        int active = getActiveIndex();
        all.remove(index);
        persist(all);
        if (all.isEmpty()) {
            prefs.edit().putInt(KEY_ACTIVE, -1).apply();
        } else if (index == active) {
            setActive(Math.min(index, all.size() - 1));
        } else if (index < active) {
            setActive(active - 1);
        }
    }

    /** 设置当前使用的服务器；下标非法时忽略。 */
    public void setActive(int index) {
        if (index < 0 || index >= list().size()) {
            return;
        }
        prefs.edit().putInt(KEY_ACTIVE, index).apply();
    }

    /** 名称或地址是否已存在（用于手动添加时的重复提示）。 */
    public boolean contains(String url) {
        String normalized = normalizeUrl(url);
        if (normalized == null) {
            return false;
        }
        for (Server existing : list()) {
            if (existing.url.equalsIgnoreCase(normalized)) {
                return true;
            }
        }
        return false;
    }

    private void persist(List<Server> servers) {
        JSONArray array = new JSONArray();
        for (Server server : servers) {
            JSONObject item = new JSONObject();
            try {
                item.put("url", server.url);
                item.put("name", server.name);
            } catch (Exception ignored) {
                // JSONObject.put(String, String) 不会抛异常，这里只是防御性写法
            }
            array.put(item);
        }
        prefs.edit().putString(KEY_SERVERS, array.toString()).apply();
    }

    // ------------------------------------------------------------------
    // 地址规范化
    // ------------------------------------------------------------------

    /**
     * 把用户输入整理成可用的服务器地址，非法输入返回 {@code null}，规则：
     *
     * <p><b>只允许 HTTPS</b>：明文的 {@code http://} 地址一律拒绝（产品策略：客户端只能通过
     * HTTPS / Cloudflare Tunnel 之类的 TLS 端点连接服务器，局域网明文 HTTP 不再可用）。
     * 因此未写协议的输入会被补成 {@code https://}，而写了 {@code http://} 的输入返回 {@code null}。
     *
     * <ol>
     *   <li>去掉首尾空白（含换行、制表符，扫码结果的换行也能处理）；</li>
     *   <li>空串 → {@code null}；</li>
     *   <li>开头的 {@code //} 会被去掉；</li>
     *   <li>不含 {@code ://} 时自动补 {@code https://}，因此 {@code 192.168.1.100:3000}、
     *       {@code print.example.com} 都会被补成 https 地址；</li>
     *   <li>协议只允许 {@code https}（大小写不敏感）；显式的 {@code http://} 与其它协议一律拒绝；</li>
     *   <li>主机名不能为空，不能是 {@code http} / {@code https}，不能包含空格、反斜杠、斜杠，
     *       也不能带用户名密码（{@code @}）；</li>
     *   <li>IPv6 字面量保留方括号（{@code [2001:db8::1]:3000}）；</li>
     *   <li>端口必须是 1–65535 的纯数字，显式端口原样保留；</li>
     *   <li>丢弃路径、查询串和锚点（薄壳只需要站点根地址），并去掉末尾的 {@code /}。</li>
     * </ol>
     *
     * @return 规范化后的地址，例如 {@code https://print.example.com}；非法时为 {@code null}
     */
    public static String normalizeUrl(String input) {
        if (input == null) {
            return null;
        }
        // 1) 去掉首尾空白（\s 覆盖换行、制表符等）
        String s = input.trim();
        s = s.replaceAll("^\\s+|\\s+$", "");
        if (s.isEmpty()) {
            return null;
        }

        // 2) 没有协议就补 https://（扫码结果里可能带换行，上面已经去掉）；
        //    开头多余的 // 先剥掉，避免拼出 https:////host
        if (!s.contains("://")) {
            while (s.startsWith("//")) {
                s = s.substring(2);
            }
            s = "https://" + s;
        }

        // 3) 校验协议：只接受 https，明文的 http:// 直接拒绝
        String lower = s.toLowerCase(Locale.US);
        String scheme;
        String rest;
        if (lower.startsWith("https://")) {
            scheme = "https";
            rest = s.substring("https://".length());
        } else {
            // 包含 http:// 以及 ftp:// 等其它协议
            return null;
        }

        // 4) 去掉路径 / 查询串 / 锚点，只保留站点根
        int cut = rest.length();
        for (int i = 0; i < rest.length(); i++) {
            char c = rest.charAt(i);
            if (c == '/' || c == '?' || c == '#') {
                cut = i;
                break;
            }
        }
        String authority = rest.substring(0, cut);

        // 5) 拒绝带用户名密码的地址：这里只面向用户自己的服务器
        if (authority.indexOf('@') >= 0) {
            return null;
        }

        // 6) 拆出主机与端口，IPv6 允许 [::1]:3000 形式
        String host;
        String port = null;
        boolean ipv6Literal = false;
        if (authority.startsWith("[")) {
            int close = authority.indexOf(']');
            if (close < 0) {
                return null;
            }
            host = authority.substring(1, close);
            ipv6Literal = true;
            String tail = authority.substring(close + 1);
            if (!tail.isEmpty()) {
                if (!tail.startsWith(":")) {
                    return null;
                }
                port = tail.substring(1);
            }
        } else {
            int colon = authority.indexOf(':');
            if (colon >= 0) {
                host = authority.substring(0, colon);
                port = authority.substring(colon + 1);
            } else {
                host = authority;
            }
        }

        // 7) 主机名合法性；同时挡掉 "http://http://x" 这类重复协议。
        //    注意：IPv6 字面量（已去掉方括号）本身含冒号，所以这里不能禁止冒号。
        if (host.isEmpty() || host.equalsIgnoreCase("http") || host.equalsIgnoreCase("https")
                || host.indexOf(' ') >= 0 || host.indexOf('\\') >= 0
                || host.indexOf('/') >= 0) {
            return null;
        }

        // 8) 端口合法性
        if (port != null) {
            if (port.isEmpty() || port.length() > 5) {
                return null;
            }
            for (int i = 0; i < port.length(); i++) {
                if (!Character.isDigit(port.charAt(i))) {
                    return null;
                }
            }
            int value;
            try {
                value = Integer.parseInt(port);
            } catch (NumberFormatException e) {
                return null;
            }
            if (value < 1 || value > 65535) {
                return null;
            }
        }

        String normalized = scheme + "://" + (ipv6Literal ? "[" + host + "]" : host)
                + (port != null ? ":" + port : "");
        // 9) 去掉末尾斜杠（拼接后理论上不会有，防御性处理）
        while (normalized.endsWith("/")) {
            normalized = normalized.substring(0, normalized.length() - 1);
        }
        return normalized;
    }
}
