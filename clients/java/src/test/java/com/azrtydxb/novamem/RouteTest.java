package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import java.nio.file.Path;
import java.util.Arrays;
import org.junit.jupiter.api.Test;

/** Every routes.json method exists on the SDK, in both its blocking and async form. */
class RouteTest {
  // proved by: renaming Client.sessionRecap fails this test.
  @Test
  void testEveryRouteIsAccounted() throws Exception {
    JsonNode routes = Json.MAPPER.readTree(Path.of("..", "contract", "routes.json").toFile());
    for (var e : routes.properties()) {
      if (!e.getValue().has("methods")) {
        continue;
      }
      for (JsonNode m : e.getValue().get("methods")) {
        String[] p = m.get("name").asText().split("\\.");
        Class<?> cls = Class.forName("com.azrtydxb.novamem." + p[0]);
        String name = Character.toLowerCase(p[1].charAt(0)) + p[1].substring(1);
        // "import" is a Java keyword (clients/gen javamethod).
        name = name.equals("import") ? "importEntries" : name;
        for (String n : new String[] {name, name + "Async"}) {
          assertTrue(
              Arrays.stream(cls.getMethods()).anyMatch(x -> x.getName().equals(n)),
              e.getKey() + " " + p[0] + "." + n);
        }
      }
    }
  }
}
