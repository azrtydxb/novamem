package com.azrtydxb.novamem;

import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.json.JsonMapper;
import com.fasterxml.jackson.databind.module.SimpleModule;
import java.time.Instant;

/** The JSON settings every request and response goes through. */
final class Json {
  /**
   * Unknown fields are ignored and unknown enum values read as UNKNOWN, so a newer server does not
   * break an older SDK. What is left out of a request is decided per field by the generated types'
   * annotations.
   */
  static final ObjectMapper MAPPER =
      JsonMapper.builder()
          .disable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES)
          .enable(DeserializationFeature.READ_UNKNOWN_ENUM_VALUES_USING_DEFAULT_VALUE)
          .addModule(
              new SimpleModule("novamem")
                  .addSerializer(Instant.class, new InstantCodec.Serializer())
                  .addDeserializer(Instant.class, new InstantCodec.Deserializer()))
          .build();

  private Json() {}
}
