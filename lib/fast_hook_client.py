"""Small Stash client for rating hooks; explicit tasks retain stashapp-tools.

Keep configuration only for this invocation. Reads use the same rating engine,
and writes use normal Stash mutations, so all other plugins still receive hooks.
"""
import json
import urllib.request


class RatingHookClient:
    def __init__(self, connection):
        host = connection.get("Host") or connection.get("Domain") or "localhost"
        if host in ("0.0.0.0", "::"):
            host = "127.0.0.1"
        if ":" in host and not host.startswith("["):
            host = "[" + host + "]"
        self.url = "{}://{}:{}/graphql".format(connection.get("Scheme") or "http", host, connection.get("Port") or 9999)
        self.headers = {"Content-Type": "application/json"}
        cookie = connection.get("SessionCookie") or {}
        if cookie.get("Value"):
            self.headers["Cookie"] = (cookie.get("Name") or "session") + "=" + cookie["Value"]
        if connection.get("ApiKey"):
            self.headers["ApiKey"] = str(connection["ApiKey"])
        self._configuration = None

    def call(self, query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.url, body, self.headers)
        with urllib.request.urlopen(request, timeout=120) as response:
            result = json.load(response)
        if result.get("errors"):
            raise RuntimeError("; ".join(error.get("message", str(error)) for error in result["errors"]))
        return result.get("data") or {}

    def get_configuration(self):
        if self._configuration is None:
            self._configuration = self.call("{configuration{plugins ui}}")["configuration"]
        return self._configuration

    def configure_plugin(self, plugin_id, values):
        # Match stashapp-tools' merge semantics, including migration flag writes.
        merged = dict((self.get_configuration().get("plugins") or {}).get(plugin_id) or {})
        merged.update(values)
        result = self.call("mutation($id:ID!,$input:Map!){configurePlugin(plugin_id:$id,input:$input)}",
                           {"id": plugin_id, "input": merged})["configurePlugin"]
        self._configuration.setdefault("plugins", {})[plugin_id] = result
        return result

    def find_scene(self, scene_id, fragment=None):
        return self.call("query($id:ID!){findScene(id:$id){id title rating100 tags{id name}}}", {"id": scene_id})["findScene"]

    def find_performer(self, performer_id, fragment=None):
        return self.call("query($id:ID!){findPerformer(id:$id){id name rating100 tags{id name}}}", {"id": performer_id})["findPerformer"]

    def update_scene(self, values):
        return self.call("mutation($input:SceneUpdateInput!){sceneUpdate(input:$input){id}}", {"input": values})["sceneUpdate"]

    def update_performer(self, values):
        return self.call("mutation($input:PerformerUpdateInput!){performerUpdate(input:$input){id}}", {"input": values})["performerUpdate"]
