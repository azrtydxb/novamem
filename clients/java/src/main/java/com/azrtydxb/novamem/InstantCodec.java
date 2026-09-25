package com.azrtydxb.novamem;

import com.fasterxml.jackson.core.JsonGenerator;
import com.fasterxml.jackson.core.JsonParser;
import com.fasterxml.jackson.databind.DeserializationContext;
import com.fasterxml.jackson.databind.JsonDeserializer;
import com.fasterxml.jackson.databind.JsonSerializer;
import com.fasterxml.jackson.databind.SerializerProvider;
import java.io.IOException;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;

/**
 * Timestamps on the wire: sent as UTC with a Z and millisecond precision, read from any RFC 3339
 * form. Hand-written so jackson-databind stays the only dependency.
 */
final class InstantCodec {
  private static final DateTimeFormatter WIRE =
      DateTimeFormatter.ofPattern("uuuu-MM-dd'T'HH:mm:ss.SSS'Z'").withZone(ZoneOffset.UTC);

  private InstantCodec() {}

  static String format(Instant t) {
    return WIRE.format(t);
  }

  static Instant parse(String s) {
    return OffsetDateTime.parse(s.trim()).toInstant();
  }

  /** The UTC form of a timestamp, or the input when it does not parse (the server answers it). */
  static String normalize(String s) {
    try {
      return format(parse(s));
    } catch (DateTimeParseException e) {
      return s;
    }
  }

  static final class Serializer extends JsonSerializer<Instant> {
    @Override
    public void serialize(Instant value, JsonGenerator gen, SerializerProvider provider)
        throws IOException {
      gen.writeString(format(value));
    }
  }

  static final class Deserializer extends JsonDeserializer<Instant> {
    @Override
    public Instant deserialize(JsonParser p, DeserializationContext ctxt) throws IOException {
      String s = p.getValueAsString();
      try {
        return parse(s);
      } catch (DateTimeParseException e) {
        return (Instant) ctxt.handleWeirdStringValue(Instant.class, s, "not an RFC 3339 timestamp");
      }
    }
  }
}
