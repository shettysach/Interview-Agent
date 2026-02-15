{
  description = "Python";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs = {
    self,
    nixpkgs,
  }: let
    system = "x86_64-linux";
    pkgs = import nixpkgs {inherit system;};

    python = pkgs.python312;
  in {
    devShells.${system}.default = pkgs.mkShell {
      packages = with pkgs; [
        # Python and package management
        python
        uv
        ruff
        ty

        livekit
        livekit-cli
      ];

      shellHook = ''
        # Python environment
        unset PYTHONPATH
        export UV_PYTHON_DOWNLOADS=never
      '';
    };
  };
}
