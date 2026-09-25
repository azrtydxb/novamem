using System;
using System.Globalization;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace Novamem;

/// <summary>The JSON settings every request and response goes through.</summary>
public static class Json
{
    /// <summary>
    /// Leaves out unset and empty optional fields (the server's schemas are
    /// strict, and an empty optional means "not given" in every SDK), writes
    /// required ones, and ignores unknown fields when reading.
    /// </summary>
    public static readonly JsonSerializerOptions Options = new()
    {
        TypeInfoResolver = new DefaultJsonTypeInfoResolver
        {
            Modifiers = { OmitEmptyOptionalStrings },
        },
    };

    static void OmitEmptyOptionalStrings(JsonTypeInfo info)
    {
        foreach (var p in info.Properties)
        {
            var optional =
                p.AttributeProvider?.GetCustomAttributes(typeof(JsonIgnoreAttribute), false)
                    .OfType<JsonIgnoreAttribute>()
                    .Any(a => a.Condition == JsonIgnoreCondition.WhenWritingNull)
                ?? false;
            if (optional && p.PropertyType == typeof(string))
            {
                p.ShouldSerialize = (_, v) => v is string s && s.Length > 0;
            }
        }
    }
}

/// <summary>
/// Sends a timestamp as UTC with a Z; a string that does not parse is sent
/// unchanged, and the server answers it.
/// </summary>
public sealed class TimestampConverter : JsonConverter<string>
{
    /// <inheritdoc />
    public override string? Read(
        ref Utf8JsonReader reader,
        Type typeToConvert,
        JsonSerializerOptions options
    ) => reader.GetString();

    /// <inheritdoc />
    public override void Write(
        Utf8JsonWriter writer,
        string value,
        JsonSerializerOptions options
    ) => writer.WriteStringValue(Normalize(value));

    /// <summary>The UTC form of a timestamp, or the input when it does not parse.</summary>
    public static string Normalize(string value) =>
        DateTimeOffset.TryParse(
            value,
            CultureInfo.InvariantCulture,
            DateTimeStyles.RoundtripKind,
            out var t
        )
            ? t.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture)
            : value;
}
