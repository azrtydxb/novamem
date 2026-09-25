package com.azrtydxb.novamem;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

/** Configuration that the shared scenarios do not reach. */
class ConfigTest {
  private static final String TOKEN = "nm_config_secret";

  // proved by: printing baseUrl verbatim in NovamemConfig.toString or
  // Base.toString fails this test.
  @Test
  void aTokenPastedIntoTheUrlIsRedactedWhenPrinted() {
    NovamemConfig cfg =
        NovamemConfig.builder().baseUrl("https://h.example/" + TOKEN).token(TOKEN).build();
    assertFalse(cfg.toString().contains(TOKEN), cfg.toString());
    for (Object c : new Object[] {new Client(cfg), new Management(cfg), new Admin(cfg)}) {
      assertFalse(c.toString().contains(TOKEN), c.toString());
    }
  }

  // proved by: dropping the query/fragment check in NovamemConfig fails this test.
  @ParameterizedTest
  @ValueSource(strings = {"https://h.example?tenant=1", "https://h.example/#frag"})
  void aBaseUrlWithAQueryOrFragmentIsRejected(String url) {
    IllegalArgumentException e =
        assertThrows(
            IllegalArgumentException.class,
            () -> NovamemConfig.builder().baseUrl(url).token(TOKEN).build());
    assertTrue(e.getMessage().contains("query or fragment"), e.getMessage());
  }
}
