# frozen_string_literal: true

module Novamem
  # The client was constructed with a missing or unusable setting.
  class ConfigError < ArgumentError; end

  # Every failure of a call. Never contains the bearer token.
  #
  # The one question every caller must be able to answer is "could the
  # store be consulted?" — #unavailable?. It is true for a refused dial, a
  # timeout, a 5xx, a 429, or a body that is not the JSON the API promises.
  # Any other Error is a real answer that was not success: a rejected token,
  # a bad request, an id that is not in your scope (#not_found?). An empty
  # result with no error is the only thing this SDK presents as "nothing is
  # stored".
  class Error < StandardError
    # The client method that failed ("search", "remove-member", …).
    attr_reader :op
    # The HTTP status, or 0 when no response was received.
    attr_reader :status_code
    # The server's machine-readable error code, when it sent one.
    attr_reader :code
    # The server's message, or a description of the transport failure.
    attr_reader :detail

    def initialize(op, detail, status_code: 0, code: "", unavailable: false, retryable: false)
      @op = op
      @detail = detail
      @status_code = status_code
      @code = code
      @unavailable = unavailable
      @retryable = retryable
      super(render)
    end

    # The store could not be consulted. Say so; do not claim ignorance.
    def unavailable? = @unavailable

    # Calling again could plausibly succeed. The SDK never retries for you.
    def retryable? = @retryable

    # The store answered: that id is not in your scope.
    def not_found? = @status_code == 404

    def inspect
      "#<#{self.class.name} op=#{@op.inspect} status_code=#{@status_code} code=#{@code.inspect} " \
        "message=#{@detail.inspect} retryable=#{@retryable}>"
    end

    private

    def render
      s = +"novamem #{@op}"
      s << ": #{@status_code}" if @status_code.positive?
      s << " [#{@code}]" unless @code.empty?
      s << ": #{@detail}" unless @detail.empty?
      s
    end
  end
end
